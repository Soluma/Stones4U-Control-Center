# ADR-007 — Centrale Customer Matching-laag voor externe bronnen (Phase 3)

**Status**: Voorgesteld (2026-09-03), onderdeel van Phase 3-architectuur. Nog niet geïmplementeerd.

## Context

Phase 3 introduceert meerdere externe bronnen die aan een `CustomerProfile` gekoppeld moeten worden zonder een stabiele, gedeelde sleutel: telefoongesprekken (TelefoonSysteem, gesleuteld op telefoonnummer), e-mail (twee providers — Microsoft 365 via Microsoft Graph voor `info@stones4u.nl`, IMAP voor `info@stones4u.eu` — beide gesleuteld op e-mailadres, provider-onafhankelijk gematcht; zie de correctie in `docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md`; eerdere versies van dit ADR gingen hier eerst onjuist uit van Gmail, daarna van Microsoft 365 als enige bron), offertes (OfferteApp/s4u-quote-app, elk met hun eigen klant-representatie). Discovery (`docs/platform-discovery/22-CUSTOMER-IDENTITY-STRATEGY.md` §3, `27-PHASE-3-DISCOVERY.md`) bevestigt dat **geen enkel systeem in het landschap vandaag een cross-systeem dedup-/matchmechanisme heeft**, en dat losse, ad-hoc matching-logica per adapter (zoals TelefoonSysteem's inconsistente telefoonnormalisatie tussen paden, zie ADR-002) precies de bugs veroorzaakt die dit platform wil vermijden.

## Besluit

Er komt **één centrale matching-laag** (`src/modules/matching/` of gelijkwaardig), gebruikt door elke Phase 3-adapter (telefonie, e-mail, offertes) — geen adapter implementeert zijn eigen matching-logica.

**Datamodel** (Prisma, additief op het bestaande schema):

```
model ExternalContactMatch {
  id                String   @id @default(cuid())
  customerProfileId String
  customerProfile   CustomerProfile @relation(fields: [customerProfileId], references: [id], onDelete: Cascade)

  source            MatchSource   // TELEFOONSYSTEEM | GMAIL | OFFERTEAPP | S4U_QUOTE_APP
  externalRef       String        // genormaliseerd telefoonnummer, e-mailadres, of extern record-ID — betekenis is source-afhankelijk
  matchedBy         MatchMethod   // PHONE | EMAIL | SHOPIFY_GID | MANUAL
  confidence        MatchConfidence // EXACT | LIKELY | MANUAL | AMBIGUOUS

  confirmedByUserId String?       // gezet zodra een mens de match bevestigt/aanmaakt — null = systeem-voorgesteld, nog niet bevestigd
  unlinkedAt        DateTime?     // soft-ontkoppeling — behoudt audittrail, verbergt uit actieve matching

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@unique([customerProfileId, source, externalRef])
  @@index([source, externalRef])
}

enum MatchSource { TELEFOONSYSTEEM, GMAIL, OFFERTEAPP, S4U_QUOTE_APP }
enum MatchMethod { PHONE, EMAIL, SHOPIFY_GID, MANUAL }
enum MatchConfidence { EXACT, LIKELY, MANUAL, AMBIGUOUS }
```

> **Correctie (2026-09-03, tweemaal)**: `GMAIL` is de naam die deze enum kreeg toen e-mail nog (onjuist) als Gmail was aangenomen. Deze waarde is inmiddels al gemigreerd naar productie (`prisma/schema.prisma`, ongebruikt — geen enkele rij verwijst er ooit naar) en wordt in deze documentatiecorrectie **niet met terugwerkende kracht gewijzigd** (geen migratie in deze correctieronde). Een eerste correctieronde stelde daarna voor om `MICROSOFT365` toe te voegen — dat voorstel is **herroepen** na de ontdekking dat Stones4U e-mail via **twee** providers ontvangt (Microsoft 365 én IMAP): een provider-specifieke matchsource zou hetzelfde klant-e-mailadres, afhankelijk van welke mailbox het toevallig het eerst zag, in twee losse matchrijen laten uiteenvallen — onnodige koppeling van een matching-concept aan een transportdetail. De definitieve aanbeveling is een generieke, providerneutrale waarde: **`EMAIL`**, toe te voegen als nieuwe, additieve enumwaarde (`ALTER TYPE "MatchSource" ADD VALUE`) bij de eerste Phase 3c-migratie — het ongebruikte `GMAIL`-lid blijft ongebruikt staan (Postgres-enums zijn niet triviaal in te korten zonder een hertype-cyclus). Zie `docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` §6 voor de volledige onderbouwing (inclusief §9 van de eerdere versie voor de tweede plek, `src/app/api/customers/[id]/matches/route.ts`, waar dezelfde `GMAIL`-waarde hardcoded voorkomt).

**Regels**:

1. **Normalisatie is verplicht en centraal.** Telefoonnummers via de al bestaande `normalizeDutchPhone()` (`src/lib/phone.ts`) — geen tweede implementatie, geen herhaling van TelefoonSysteem's eigen inconsistentie (ADR-002). E-mail via een nieuwe, even centrale `normalizeEmail()` (trim + lowercase, gespiegeld aan wat al in TelefoonSysteem's eigen `customerHistoryService.ts` gebeurt, zie `20-CUSTOMER-HISTORY-DATA-MODEL.md` §3 — maar hier vanaf het begin consistent toegepast, niet per-pad opnieuw uitgevonden).
2. **Nooit een twijfelachtige match stilzwijgend definitief opslaan.** Een automatische match op basis van telefoon/e-mail waarbij **meerdere** kandidaat-`CustomerProfile`'s mogelijk zijn, wordt opgeslagen met `confidence = AMBIGUOUS` en **niet** gebruikt om data te tonen totdat een mens kiest — exact het principe dat TelefoonSysteem's eigen automatische Shopify-verrijkingspad breekt (`22-CUSTOMER-IDENTITY-STRATEGY.md` §1: bij `'multiple'`-status wordt daar stil niets gedaan, wat de omgekeerde fout is — hier kiezen we zichtbaar-onzeker boven onzichtbaar-stil).
3. **Handmatige koppeling en ontkoppeling** zijn eersteklas acties, niet een noodgreep: een medewerker kan een voorgestelde match bevestigen, een gemiste match handmatig leggen (`matchedBy = MANUAL`), of een bestaande match ontkoppelen (`unlinkedAt` gezet, rij blijft bestaan voor audit). Elke van deze drie acties schrijft een `AuditEvent` (bestaand mechanisme, `src/platform/audit/audit.ts`, uit te breiden met nieuwe `AuditAction`-waarden).
4. **Eén rij per (klant, bron, external ref)** — de `@@unique`-constraint voorkomt duplicaten bij herhaalde matching-runs; een hermatch-poging is een upsert, geen nieuwe rij. **`externalRef` is de externe CONTACTIDENTITEIT (genormaliseerd telefoonnummer/e-mailadres), nooit een gebeurtenis-/bericht-ID** — dit is wat Rule 4's "hermatch-poging is een upsert" pas betekenisvol maakt: alleen een stabiele identiteitswaarde levert bij herhaling dezelfde rij op. (Voor OFFERTEAPP/S4U_QUOTE_APP is `externalRef` terecht wél een extern record-ID — daar ís het record zelf, niet een contactidentiteit, het ding dat gekoppeld wordt.) Deze regel werd voor e-mail aanvankelijk verkeerd geïmplementeerd (`stableEmailId(message)`, een bericht-ID, als `externalRef` — één rij per bericht in plaats van één per adres) en vóór productie gecorrigeerd — zie `docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md` voor de volledige analyse en fix.
5. **`AMBIGUOUS`-matches worden in de UI expliciet als keuzelijst getoond** (zelfde patroon als TelefoonSysteem's eigen `ShopifyCustomerPanel`-keuzescherm bij meerdere Shopify-klanten met hetzelfde nummer, `22` §1 — hergebruikt als UX-referentie, niet als code) — nooit een verborgen `LIMIT 1`-keuze zoals TelefoonSysteem's Exact-historie-database doet (`20` §10, expliciet als negatief voorbeeld).

## Consequenties

- Elke Phase 3-adapter (telefonie, e-mail, offertes) roept dezelfde matching-functies aan (`matchByPhone(number)`, `matchByEmail(address)`, `getConfirmedMatches(customerProfileId, source)`) in plaats van eigen matching-code te schrijven — voorkomt dat Phase 3 drie keer dezelfde inconsistentie introduceert die Phase 1/2 juist vermeden hebben.
- Voegt één nieuwe tabel + drie enums toe aan het schema — puur additief, geen wijziging aan bestaande modellen.
- `ExternalContactMatch` bevat **nooit** de externe data zelf (geen gespreksinhoud, geen e-mailtekst, geen offertedetails) — uitsluitend de matchrelatie. De daadwerkelijke data blijft live/gefedereerd opgehaald per adapter (zie ADR-008).
- Dit ADR beslist de **matching-architectuur**, niet welke adapters in Phase 3 daadwerkelijk geactiveerd worden — dat blijft afhankelijk van de sibling-zijdige service-auth-trajecten uit `27-PHASE-3-DISCOVERY.md` §5/§6.
