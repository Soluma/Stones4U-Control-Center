# 28 — Phase 3 Architectuur: Adapters, Matching, Timeline, Customer 360 UX

Vervolg op `27-PHASE-3-DISCOVERY.md`. Legt de architectuurbeslissingen vast — formeel geborgd in ADR-007 (customer matching) en ADR-008 (externe communicatie/timeline). Nog geen implementatie.

## 1. Adapterarchitectuur — uitbreiding van het bestaande patroon

Phase 3 introduceert **geen nieuw architecturaal patroon** — het gebruikt exact de al bewezen adapter-interface uit `src/integrations/{telephony,exact,quotes}/adapter.ts` (interface + `Disabled*`-implementatie, nooit throwen, altijd leeg/null bij onbeschikbaarheid). Vier adapters, elk in zijn eigen map onder `src/integrations/`:

```
src/integrations/
  telephony/adapter.ts      (bestaat al — DisabledTelephonyAdapter — Phase 3 voegt een echte
                              implementatie toe ZODRA de TelefoonSysteem-zijdige service-auth bestaat;
                              tot die tijd blijft de Disabled-variant actief)
  email/adapter.ts          (nieuw — Gmail-adapter, per verbonden mailbox)
  quotes/adapter.ts         (bestaat al als lege placeholder — Phase 3 voegt OfferteApp- en
                              s4u-quote-app-implementaties toe ZODRA hun service-auth bestaat)
  shopify/draft-orders.ts   (nieuw — geen adapter-interface nodig, dezelfde client-credentials-
                              client als orders.ts/customers.ts, geen externe blokkade)
```

**Interface-vorm** (gespiegeld aan de bestaande `TelephonyAdapter`):

```ts
export interface TelephonyAdapter {
  status(): { available: true } | { available: false; reason: string };
  getCallsForPhoneNumbers(phoneNumbers: string[]): Promise<CallActivityItem[]>;
}

export interface EmailAdapter {
  status(): { available: true } | { available: false; reason: string };
  getMessagesForAddresses(addresses: string[]): Promise<EmailActivityItem[]>;
}

export interface QuotesAdapter {
  status(): { available: true } | { available: false; reason: string };
  getQuotesForCustomer(matchRefs: { shopifyCustomerGid?: string; email?: string }): Promise<QuoteActivityItem[]>;
}
```

Elke adapter is **losstaand schakelbaar** via env-var-aanwezigheid (zelfde patroon als `isShopifyConfigured()`/`isStorageConfigured()`) — een ontbrekende/onvolledige configuratie degradeert naar `available: false`, nooit een crash, nooit een halfwerkende UI. Customer 360 blijft **volledig bruikbaar** met nul, één, twee, drie, of vier adapters actief — dit is al het bewezen gedrag van de bestaande telefonie/Exact-adapters in Phase 1/2 en wordt letterlijk hergebruikt, niet opnieuw uitgevonden.

## 2. Customer matching — zie ADR-007

Elke adapter roept de centrale matching-laag aan om zijn externe records aan een `CustomerProfile` te koppelen — geen adapter implementeert eigen matching. Zie ADR-007 voor het volledige datamodel (`ExternalContactMatch`) en de regels rond confidence/ambiguïteit/handmatige koppeling.

**Praktische matching-flow per adapter**:
- **Telefonie**: `CustomerProfile.phoneNormalized` (al bestaand veld) ↔ TelefoonSysteem `Call.callerNumber` genormaliseerd via `normalizeDutchPhone()`. Bij meerdere `CustomerProfile`'s met hetzelfde genormaliseerde nummer: `AMBIGUOUS`, tonen als keuze.
- **E-mail**: `CustomerProfile.email` (al bestaand veld, van Shopify) ↔ Gmail `to:`/`from:`-adres, genormaliseerd via de nieuwe `normalizeEmail()`. Alternatieve adressen: alleen via `matchedBy = MANUAL` — geen automatische aanname dat een ander adres "waarschijnlijk" dezelfde persoon is.
- **Offertes**: primair `shopifyCustomerGid` (beide offerte-apps refereren al aan Shopify-klant-ID's, zie `27` §4) — sterkste sleutel, geen ambiguïteit te verwachten zolang de offerte-app zelf een correcte Shopify-koppeling heeft; secundair e-mail als fallback voor offertes zonder Shopify-koppeling.

## 3. Activity Timeline-uitbreiding — zie ADR-008

Negen nieuwe `ActivityType`-waarden (`CALL_INBOUND`, `CALL_OUTBOUND`, `CALL_MISSED`, `EMAIL_INBOUND`, `EMAIL_OUTBOUND`, `QUOTE_CREATED`, `QUOTE_UPDATED`, `DRAFT_ORDER_CREATED`), **allemaal categorie B** (live geprojecteerd, nooit opgeslagen) — zie ADR-008 voor de volledige onderbouwing en het dedup-/caching-beleid.

`getCustomerTimeline()` (`src/modules/activity/timeline.ts`) krijgt vier nieuwe, parallel op te halen projectiebronnen naast de bestaande (owned Activity-rijen, Shopify-orders, telefonie, Exact) — precies dezelfde `Promise.all`-structuur die er al staat, uitgebreid met `getShopifyDraftOrders()`, `emailAdapter.getMessagesForAddresses()`, `quotesAdapter.getQuotesForCustomer()`. Elke bron faalt onafhankelijk (bestaand patroon, niet gewijzigd).

## 4. Customer 360 — informatie-architectuur (kritisch getoetst tegen "geen tab-overload")

**Uitgangspunt**: de huidige 7 tabs (Overzicht, Orders, Activiteit, Notities, Taken, Afspraken, Bestanden) werken en zijn recent (Phase 2) bewust ontworpen. De opdracht vraagt kritische toetsing, niet automatisch meer tabs toevoegen voor elke nieuwe databron.

**Voorstel: 0 nieuwe top-level tabs.** In plaats daarvan:

1. **Overzicht** — twee nieuwe compacte blokken naast de bestaande (openstaande taken/komende afspraken/recente bestanden, Phase 2-patroon): **"Recente gesprekken"** en **"Recente e-mails"** (elk: laatste 3-5 items, klein, geen paginaverversing nodig — zelfde stijl als de bestaande blokken). Geen nieuwe tab, wél direct zichtbaar — voldoet aan "belangrijkste informatie direct zichtbaar."
2. **Activiteit** (bestaande tab, ongewijzigde naam) — ontvangt de negen nieuwe event-types gewoon chronologisch tussen de bestaande (zie §3). Dit wordt de facto de volledige communicatie-tijdlijn — geen aparte "Communicatie"-tab nodig, want de Activiteit-tab is daar al voor bedoeld. Als de lijst in de praktijk te lang/druk wordt, is een filterbalk (chips: Alles/Gesprekken/E-mail/CRM/Commercieel) een lichte, latere toevoeging binnen deze ene tab — geen tabuitbreiding.
3. **Orders** (bestaande tab) — hernoemen naar **"Commercieel"** en uitbreiden met sub-secties binnen dezelfde tab: bestaande Orders (ongewijzigd), nieuw **Concept-orders** (Shopify draft orders, §27 §3), nieuw **Offertes** (zodra de offerte-adapters beschikbaar zijn) — één tab, drie interne secties/filters, in plaats van drie tabs. Dit groepeert "commerciële historie" precies zoals de opdracht vraagt.
4. **Notities, Taken, Afspraken, Bestanden** — ongewijzigd.

**Resultaat**: netto **7 tabs, zelfde aantal als vandaag** (Overzicht, Activiteit, Commercieel [was Orders], Notities, Taken, Afspraken, Bestanden). Geen dashboard-overload, geen nieuwe navigatielaag om te leren. Dit is de primaire aanbeveling.

**Alternatief, expliciet niet aanbevolen maar genoemd voor volledigheid**: aparte "Communicatie"- en "Commercieel"-tabs naast Activiteit/Orders. Zou herkenbaarder kunnen zijn voor wie specifiek "alle telefoongesprekken" wil zien zonder ruis, maar voegt 2 tabs toe (9 totaal) voordat er echt gebruiksdata is die dat rechtvaardigt. **Aanbeveling: begin met optie 1 (0 nieuwe tabs), heroverweeg pas op basis van echt gebruik na Phase 3-livegang.**

## 5. Search / Command Palette-uitbreiding

Huidige groepen (Phase 2): `customers` (via Shopify), `tasks` (via CRM), `navigation` (statisch, client-side). Phase 3-kandidaten, per bron getoetst op haalbaarheid:

| Nieuwe groep | Haalbaar zonder blokkade? | Aanpak |
|---|---|---|
| Ordernummers | **Ja** — Shopify is al client-credentials-bereikbaar | Nieuwe `searchShopifyOrders(term)`-functie, zelfde patroon als bestaande customer-search |
| Offerte-ID's | **Nee** — blijft geblokkeerd zolang OfferteApp/s4u-quote-app geen service-auth hebben (§27 §4) | Niet in Phase 3 te bouwen; groep verschijnt pas zodra adapter live is |
| Telefoonnummers (gesprek opzoeken) | **Nee** — zelfde blokkade als telefonie-adapter (§27 §1.2). Klant-zoeken op telefoonnummer werkt al via de bestaande Shopify-customer-search, dus dit betreft specifiek "vind het gesprek", niet "vind de klant" | Niet in Phase 3 te bouwen |
| E-mailinhoud | **Expliciet buiten scope** (instructie: "hoeft niet automatisch globaal geïndexeerd te worden") | Nooit globaal doorzoekbaar — alleen zichtbaar in Customer 360-context |

**Praktisch gevolg**: van de vier gevraagde uitbreidingen is er in Phase 3 zelf maar één daadwerkelijk te bouwen (ordernummers) — de rest volgt automatisch zodra de onderliggende adapters (telefonie/offertes) in een latere fase geactiveerd worden, zonder dat de zoek-infrastructuur zelf opnieuw ontworpen hoeft te worden (dezelfde group-based response-vorm die al sinds Phase 1 bewust generiek is gehouden, zie `25-PHASE-1-BUILD-SPEC.md` §Command Search).

## 6. Wat dit ontwerp bewust NIET doet

- Geen directe databasekoppelingen naar TelefoonSysteem/OfferteApp/s4u-quote-app.
- Geen synchronisatie/kopie van externe data naar Control Center's eigen database (behalve de dunne matchrelatie uit ADR-007).
- Geen nieuwe auth-systemen binnen Control Center zelf — Gmail-OAuth-tokens en toekomstige sibling-service-tokens zijn per-adapter-geheimen, geen wijziging aan Control Center's eigen gebruikers-/sessiemodel.
- Geen mailclient, geen bellen-vanuit-browser, geen offerte-editor — bevestigt de expliciete out-of-scope-lijst uit de opdracht, zie `29-PHASE-3-BUILD-SPEC.md` §15.
