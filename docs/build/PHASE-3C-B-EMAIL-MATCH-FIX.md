# Phase 3C-B — Email match storage fix: identity vs. interaction

**Status**: gecorrigeerd, getest (235/235 tests groen, typecheck/lint/build groen), gedeployed naar `stones4u-control-center-staging`, staging-legacydata opgeschoond, met echte Xel-IMAP-data opnieuw gevalideerd. Niet gecommit, niet gepusht, geen productie-actie.

Vervolg op `docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md`, `docs/build/PHASE-3C-B-IMAP-STAGING.md`. Dit document beschrijft een architectuurfout die pas na een gerichte review (vóór de geplande productie-uitrol) aan het licht kwam, en de correctie ervan.

## 1. De fout

De oorspronkelijke Phase 3C-A/B-implementatie van `recordMatchesForMessages()` (`src/integrations/email/adapter.ts`) gebruikte `stableEmailId(message)` — een **bericht-scoped** identifier (`m365-{mailboxId}-{messageId}` / `imap-{mailboxId}-{uidValidity}-{uid}`) — als `ExternalContactMatch.externalRef`. Dat produceerde **één matchrij per e-mailbericht** in plaats van één matchrij per externe contactidentiteit, met reële staging-data bevestigd: 25–26 rijen voor één klant met een actieve correspondentiegeschiedenis, in plaats van de bedoelde 1.

## 2. Identity vs. interaction — de kernonderscheiding

| | Concept | Voorbeeld | Waar | Levensduur |
|---|---|---|---|---|
| **A. Customer identity** | Welk extern e-mailadres hoort bij welke `CustomerProfile`? | `js@verkoelengroep.nl` | `ExternalContactMatch.externalRef` | Stabiel — verandert niet zolang de klant hetzelfde adres gebruikt |
| **B. Interaction identity** | Welk specifiek bericht is dit, uniek en botsingsvrij over providers/mailboxen heen? | `imap-{mailboxId}-{uidValidity}-{uid}` | `stableEmailId()` → Timeline-synthetische ID (`src/modules/activity/timeline.ts`) | Eén per bericht, nooit opgeslagen (ADR-008 categorie B) |

Beide identiteiten zijn legitiem en nodig — maar voor **verschillende lagen**:
- **A (matching-laag, ADR-007)** beantwoordt: "is dit e-mailadres al eens gezien voor deze klant, en is dat ondubbelzinnig?" — een vraag over de **klant-identiteit**, die per definitie niet verandert met elk nieuw bericht.
- **B (Timeline-laag, ADR-008)** beantwoordt: "geef dit ene bericht een stabiele, botsingsvrije weergave-ID zodat de tijdlijn correct en dedupliceerd rendert" — een vraag over **één specifieke gebeurtenis**.

De fout ontstond doordat beide vragen toevallig door dezelfde helper-functie (`stableEmailId()`) beantwoord leken te kunnen worden — ze hebben oppervlakkig dezelfde vorm (een string die een bericht identificeert), maar horen conceptueel bij verschillende, bewust gescheiden ADR's. **Na de fix roept `adapter.ts` `stableEmailId()` nergens meer aan** — die functie blijft uitsluitend gebruikt in `timeline.ts`, voor precies het doel waarvoor ADR-008 hem ontwierp.

## 3. De fix

`src/integrations/email/adapter.ts`, `recordMatchesForMessages()`:

**Vóór**: per bericht, per deelnemer, één `resolveAndRecordByEmail(participant.address, "EMAIL", stableEmailId(message))`-aanroep — `externalRef` = bericht-ID.

**Na**: eerst worden alle externe (niet-mailbox-eigen) deelnemer-adressen over **alle** berichten van de batch verzameld in een `Set` (met defensieve her-normalisatie via `normalizeEmail()`, zodat twee anders-geschreven vormen van hetzelfde adres nooit als twee verschillende identiteiten tellen — een robuustheidslaag die tijdens het testen zelf nodig bleek, zie §4), daarna precies één `resolveAndRecordByEmail(address, "EMAIL", address)`-aanroep per **distinct** adres. `externalRef` = het genormaliseerde e-mailadres zelf.

```ts
// src/integrations/email/adapter.ts, recordMatchesForMessages()
const externalAddresses = new Set<string>();
for (const message of messages) {
  const mailboxAddress = normalizeEmail(message.mailboxAddress);
  const candidates = message.direction === "INBOUND" ? [message.from] : [...message.to, ...message.cc];
  for (const participant of candidates) {
    const normalized = normalizeEmail(participant.address);
    if (normalized && normalized !== mailboxAddress) externalAddresses.add(normalized);
  }
}
for (const address of [...externalAddresses].slice(0, MAX_MATCHED_ADDRESSES_PER_LOAD)) {
  await resolveAndRecordByEmail(address, "EMAIL", address);
}
```

Geen wijziging aan `resolveAndRecordByEmail()`/`matching.service.ts` (ongewijzigd, correct herbruikt) en geen wijziging aan `timeline.ts`/`stableEmailId()` (ongewijzigd, correct — de Timeline-ID blijft bericht-scoped, precies zoals ADR-008 bedoelt). Geen schema-/migratiewijziging.

## 4. Tijdens het testen zelf gevonden robuustheidsgat

Een eerste testversie ("Example@Domain.nl" vs. "example@domain.nl" moeten dezelfde `externalRef` opleveren) faalde aanvankelijk: `recordMatchesForMessages()` vertrouwde volledig op `NormalizedEmailParticipant.address` se gedocumenteerde contract ("altijd al genormaliseerd door de producerende adapter") zonder dat zelf te herbevestigen. In de twee echte adapters (`Microsoft365EmailAdapter`, `ImapEmailAdapter`) wordt dat contract vandaag correct nageleefd — dus dit was geen bug die ooit echte data raakte — maar het maakte de matching-laag **stil afhankelijk** van correcte discipline in elke toekomstige provider-adapter, precies het soort fragiele aanname die ADR-007 regel 1 ("normalisatie is verplicht en centraal") wil voorkomen. Opgelost door `normalizeEmail()` opnieuw, defensief, binnen `recordMatchesForMessages()` zelf toe te passen — kosteloos (idempotent) en garandeert correctheid ongeacht wat een toekomstige adapter aanlevert.

## 5. Schaalgedrag — voor en na

| | Vóór de fix | Na de fix |
|---|---|---|
| Rijen per klant met N berichten van hetzelfde adres | N (onbegrensd, evenredig aan berichtvolume) | 1 (begrensd door aantal **distinct** adressen) |
| Bevestigd met echte staging-data | 26 rijen voor één klant (Xel-mailbox, echte correspondentie) | 1 rij, zelfde klant, zelfde berichtvolume |
| Databaseschrijfacties per paginabezoek | Tot 25 upserts (één per bericht × deelnemer) | Tot enkele upserts (één per distinct adres, `MAX_MATCHED_ADDRESSES_PER_LOAD = 25` als absoluut plafond) |
| Herhaald paginabezoek (geen nieuwe berichten) | Rijaantal bleef gelijk (upsert werkte al correct), maar wél N herhaalde no-op-schrijfacties | Rijaantal blijft gelijk, met veel minder herhaalde schrijfacties |
| `getMatchesForCustomer()`-bruikbaarheid voor een toekomstige "bevestigde matches"-UI | Onbruikbaar bij volume (duizenden rijen mogelijk voor één actieve klant) | Blijft overzichtelijk — één rij per werkelijke identiteit |
| Handmatige unlink-actie | Zou (bij volume) duizenden rijen moeten raken om één klant volledig te ontkoppelen | Eén rij, één actie — zoals ADR-007 regel 3 bedoelt |

## 6. Staging legacy cleanup

**Vóór cleanup**: 26 `ExternalContactMatch`-rijen met `source = EMAIL`, allemaal bericht-ID-vormig (`imap-{mailboxId}-{uidValidity}-{uid}`), allemaal `confidence = EXACT`, **nul** handmatig bevestigd (`confirmedByUserId`), **nul** met `matchedBy = MANUAL`, **nul** ontkoppeld (`unlinkedAt`) — uitsluitend automatisch gegenereerde Phase 3C-B-teststagingdata, geraakte 2 distincte `CustomerProfile`-rijen.

Read-only geïnspecteerd, alle vier veiligheidscriteria uit de opdracht expliciet bevestigd vóór verwijdering (exact aantal, bericht-ID-vorm, geen handmatig bevestigde rijen, alleen `source = EMAIL` geraakt — 0 rijen van andere `MatchSource`-waarden bestonden op staging, dus "niet aanraken" was triviaal gegarandeerd). **Na cleanup**: 0.

Na de eerste echte-data-E2E-hertest (met de gecorrigeerde code): opnieuw exact 1 rij aangemaakt voor dezelfde testklant, met de canonieke `externalRef` — bevestigt dat de fix zowel de bestaande foutieve data corrigeert (via opschoning) als nieuwe foutieve data voorkomt (via de codefix).

## 7. Verificatie tegen echte Xel-data (staging, na de fix)

- `EMAIL`-matchrijen vóór enige paginalaad: 0.
- Na eerste paginalaad (klant met 1 inkomend + 24 (van 28, gecapt) uitgaand weergegeven bericht): **1** rij, `externalRef = "js@verkoelengroep.nl"` — canoniek genormaliseerd e-mailadres, geen bericht-ID-vorm (structureel en op waarde geverifieerd).
- Na tweede, herhaalde paginalaad (refresh): nog steeds **1** rij — geen groei.
- Klant zonder correspondentie: correcte lege status, geen fout.
- Regressieroutes (dashboard, klantenlijst, takenlijst, command palette): allemaal 200, geen foutgrens.
- Microsoft 365 blijft disabled/geparkeerd, IMAP functioneert onafhankelijk — ongewijzigd, geen regressie op de bestaande fail-safe-aggregatie.
