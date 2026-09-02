# 22 — Customer Identity strategie (getoetst aan TelefoonSysteem)

> **ARCHITECTUURWIJZIGING 2026-09-01**: dit document is **geformaliseerd** als `docs/architecture/ADR-002`. Het besluit hieronder ("Shopify blijft commerciële bron, CRM krijgt eigen CustomerProfile met stabiele Shopify-GID-relatie") staat ongewijzigd en is nu het officiële, vastgelegde besluit — dit document blijft de onderliggende analyse/onderbouwing. Zie [25-PHASE-1-BUILD-SPEC.md](25-PHASE-1-BUILD-SPEC.md) §4 voor het concrete `CustomerProfile`-datamodel dat hieruit volgt.

## 1. Shopify-matching in TelefoonSysteem

Bron: `apps/api/src/services/shopifyService.ts`, `apps/ami-worker/src/services/shopifyService.ts` (bijna identieke kopie), `apps/api/src/routes/shopify.ts`, `apps/ami-worker/src/services/callCorrelation.ts`.

### Matching-mechanisme

**Uitsluitend op telefoonnummer** in de call-context (niet op e-mail) — handmatige vrije-tekstzoekopdrachten (`GET /api/contacts/search`) kunnen wel op elk Shopify-doorzoekbaar veld matchen, inclusief e-mail, maar de automatische call-gebonden verrijking is telefoon-only.

**Normalisatie** (`normalizePhoneForLookup`, gedupliceerd in beide Shopify-service-bestanden): strip `[\s\-().]`, genereer vervolgens kandidaten in meerdere formaten (ruw, `+`-prefix, zonder prefix, en specifiek Nederlandse `+31`↔`0`↔`31`↔`0031`-conversies). Kandidaten worden **op volgorde geprobeerd, stoppend bij het eerste formaat dat een Shopify-match oplevert**. Dit is aanmerkelijk sterker dan de normalisatie in de Exact-historiedatabase (zie [20-CUSTOMER-HISTORY-DATA-MODEL.md](20-CUSTOMER-HISTORY-DATA-MODEL.md) §3).

### Shopify Customer GID / lokale identifiers

**De Shopify-klant-GID wordt nergens lokaal opgeslagen.** Elke lookup is live: `customers(first: N, query: "phone:{kandidaat}")` via GraphQL, opnieuw uitgevoerd bij elke paginaweergave (`GET /api/calls/:id/shopify/customer`). Alleen de **resolved naam** (platte string) wordt teruggeschreven naar `Call.callerName`/`Contact.displayName` — nooit het Shopify-ID zelf. Een CRM dat dit wil hergebruiken, moet dus zelf een houdbare Shopify-referentie opbouwen; TelefoonSysteem biedt die niet kant-en-klaar.

### Snapshots

Geen — er wordt niets van de Shopify-klant lokaal bewaard behalve de naam-string (zie boven). Orders/draft-orders worden per paginaweergave live opgehaald (`getCustomerOrders`, `getCustomerDraftOrders`), nooit gecachet.

### Ambiguïteit — meerdere Shopify-klanten met hetzelfde telefoonnummer

**Reëel scenario bij een zakelijke telefoonlijn, en verschillend behandeld per pad**:
- **Handmatig/UI-pad** (`GET /api/shopify/customers/search` → `ShopifyCustomerPanel.tsx`): bij meerdere treffers toont de UI expliciet een keuzescherm ("Meerdere klanten gevonden — maak een keuze") met naam/telefoon/e-mail/aantal orders per kandidaat.
- **Automatisch verrijkingspad** (AMI-worker, `enrichWithShopifyName`): bij een `'multiple'`-status wordt **stil niets gedaan** — geen naam, geen waarschuwing, geen log zichtbaar voor de medewerker. `Call.callerName` blijft op de ruwe (vaak lege) AMI-callerID staan totdat iemand de gespreksdetailpagina opent, waar `ShopifyCustomerPanel` de lookup zelfstandig herhaalt en dan wél het keuzescherm toont.

**Gevolg voor een CRM-timeline**: als het CRM alleen `Call.callerName` hergebruikt, mist het stilzwijgend de gevallen met een gedeeld telefoonnummer — een CRM-integratie moet zelf, net als `ShopifyCustomerPanel`, met een `'multiple'`-status kunnen omgaan in plaats van blind op de opgeslagen naam te vertrouwen.

### Synchronisatie — schrijft TelefoonSysteem naar Shopify?

**Ja — dit is geen read-only Shopify-integratie**, in tegenstelling tot wat eerder (zonder broncode) werd aangenomen:
- `createCustomer()` voert een `customerCreate`-**mutatie** uit, bereikbaar via `POST /api/shopify/customers` ("Nieuwe klant aanmaken" in de UI).
- Vereiste scopes bevestigd in `.env.example`: `read_customers, write_customers, read_orders, read_draft_orders`.
- Na het aanmaken/openen van een Shopify-klant repareert `backfillCallerNameForPhone()` retroactief historische `Call`/`Contact`-namen in TelefoonSysteem's eigen database.
- **Geen schrijfacties naar Shopify-orders** — die blijven read-only.

### Authenticatiepatroon (bevestigt eerdere inferentie)

**Statisch, langlevend Admin API-token** (`SHOPIFY_ACCESS_TOKEN`, `shpat_...`-formaat), direct als `X-Shopify-Access-Token`-header — geen OAuth-handshake. Dit bevestigt de eerder (op basis van Fly-secretsnamen) al vermoede "Patroon B"-indeling voor telefoon-* in [03-SHOPIFY-INTEGRATION-MAP.md](03-SHOPIFY-INTEGRATION-MAP.md), nu met broncode geverifieerd. API-versie: `2026-01` (nieuwer dan zowel POS' `2026-07`... nee, ouder — ter vergelijking: POS `2026-07`, OfferteApp `2025-01`, locatie `2025-07`, TelefoonSysteem `2026-01` — een vijfde losse versie in het landschap).

## 2. Toetsing van het eerdere besluit

**Eerder besluit** (impliciet in [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md)/[16-PLATFORM-BOUNDARIES.md](16-PLATFORM-BOUNDARIES.md)): *"Shopify blijft commerciële bron voor customer identity; het CRM krijgt een eigen CustomerProfile voor CRM-specifieke data."*

**TelefoonSysteem bevestigt dit besluit — het weerlegt het niet, en levert er een concrete, werkende referentie-implementatie bij, mét een aantal reeds bekende zwaktes om niet te herhalen:**

1. **Bevestiging**: TelefoonSysteem's eigen `Contact`-model is precies het patroon dat het besluit voorschrijft — een lichte lokale rij die naar Shopify verwijst (weliswaar zwak, via telefoonnummer-string in plaats van een bewaarde GID) zonder zelf de klant-stamgegevens te dupliceren. Dit is verder bewijs (naast OfferteApp's `CustomerCache`) dat "Shopify blijft bron van waarheid, lokale apps houden een dunne verwijzing" al de facto de praktijk is in het landschap — geen enkele onderzochte app bouwt een eigen concurrerende klant-stamtabel.
2. **Wat het CRM beter moet doen dan TelefoonSysteem**:
   - **Wél de Shopify-GID persisteren** op de lokale identiteitsrij (TelefoonSysteem doet dit niet — een gemiste kans die het CRM niet moet herhalen).
   - **Consistente telefoonnormalisatie overal**, inclusief op het kritieke pad (TelefoonSysteem's eigen call-matching gebruikt inconsistent wél/niet dezelfde normalisatie — een bug, geen ontwerpkeuze, die het CRM niet moet overnemen).
   - **Expliciete afhandeling van "meerdere Shopify-klanten met dit contactmoment"** in élk pad, niet alleen het handmatige (TelefoonSysteem's automatische pad negeert dit stilzwijgend).
   - **Eén matching-strategie voor telefoon én e-mail**, niet telefoon-only voor het ene pad en alles voor het andere.
3. **Nieuwe vraag die TelefoonSysteem oproept, nog niet eerder overwogen**: TelefoonSysteem's `Contact` is telefoonnummer-gesleuteld, OfferteApp's `CustomerCache` is Shopify-customer-ID-gesleuteld, s4u-quote-app slaat klantgegevens alleen als snapshot op. **Drie verschillende lokale-identiteit-sleutels voor "dezelfde" persoon.** Een toekomstig CRM `CustomerProfile` moet zijn eigen, stabiele sleutel hebben (bijv. de Shopify-GID als primaire externe sleutel, met telefoonnummer(s) en e-mailadres(sen) als aparte, meervoudige matching-attributen) — niet blind één van deze drie patronen overnemen.

**Conclusie**: het besluit staat, wordt aangescherpt in plaats van herzien. Zie [14-SHARED-CORE-DESIGN.md](14-SHARED-CORE-DESIGN.md) (bijgewerkt) voor de geconsolideerde Customer Identity-aanbeveling.

## 3. Risico op dubbele klantidentiteiten (samenvatting, cross-systeem)

| Systeem | Sleutel | Dedup-garantie? |
|---|---|---|
| Shopify zelf | GID | Shopify's eigen probleem, buiten scope |
| TelefoonSysteem `Contact` | telefoonnummer (`@unique`) | Binnen de tabel gegarandeerd uniek, maar geen koppeling tussen meerdere nummers van dezelfde persoon — twee nummers = twee Contacts |
| TelefoonSysteem `ExactCustomer` | geen unieke sleutel | Geen garantie — duplicaten mogelijk, `LIMIT 1` zonder `ORDER BY` kan een willekeurige rij teruggeven |
| OfferteApp `CustomerCache` | `shopify_customer_id` (uniek) | Uniek per Shopify-klant, maar geen matching-laag ervoor — afhankelijk van correcte Shopify-ID bij upsert |
| s4u-quote-app `Quote` | geen — snapshot per aanvraag | Geen identiteit, geen dedup nodig/mogelijk (bewust) |

**Geen enkel systeem in het landschap heeft vandaag een cross-systeem dedup-/merge-mechanisme.** Dit is een kernvereiste voor het CRM's eigen `CustomerProfile`, niet iets dat van een bestaand systeem geërfd kan worden.
