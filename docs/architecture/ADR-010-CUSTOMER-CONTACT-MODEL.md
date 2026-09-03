# ADR-010 — CustomerContact-model en de relatie met ExternalContactMatch

**Status**: Geïmplementeerd, staging-geverifieerd (2026-09-03). §4's
gearchiveerd-contact-scenario is bij implementatie gecorrigeerd naar een
striktere variant dan hier oorspronkelijk voorgesteld — zie de inline
correctie in §4 en `docs/build/PHASE-4C-CONTACTS-STAGING.md` §5 voor het
volledige verhaal. De rest van dit ADR is ongewijzigd geïmplementeerd.

## Context

`CustomerProfile` (ADR-002) representeert vandaag feitelijk één
klantidentiteit met precies één bekend e-mailadres en telefoonnummer — de
Shopify-accounthouder. Voor zakelijke klanten (`companyName` gezet) is dat
onvoldoende: een organisatie heeft doorgaans meerdere relevante personen
(eigenaar, uitvoerder, administratie). Zie
`docs/platform-discovery/37-PHASE-4C-CONTACTS-DISCOVERY.md` voor de volledige
inventarisatie. Twee vragen vergen een echte architectuurbeslissing, geen
gewone build-keuze:

1. Hoe verhoudt een nieuw `CustomerContact`-model zich tot het bestaande
   `ExternalContactMatch` (ADR-007), dat externe identiteiten al aan een
   `CustomerProfile` koppelt — zonder een derde identiteitslaag te creëren?
2. Hoe blijft "wie is dit specifiek" een **veilige, nooit geraden** afleiding
   in plaats van fuzzy matching?

## Besluit

### 1. `CustomerContact` is een nieuw, additief model — geen uitbreiding van `CustomerProfile`

Een contactpersoon behoort in Phase 4C aan **exact één** `CustomerProfile`
(geen many-to-many) — de eenvoudigste variant die de gestelde businesscase
("Jansen Tuinen BV heeft drie contactpersonen") volledig dekt, zonder een
relatietabel die niets in de praktijk gebruikt wordt. Als een persoon ooit
relevant blijkt bij twee afzonderlijke `CustomerProfile`-rijen (zeldzaam:
twee losse Shopify-accounts van hetzelfde bedrijf), is dat twee losse
`CustomerContact`-rijen — geen gedeelde identiteit, exact zoals
`CustomerProfile` zelf nooit gedeeld wordt tussen twee Shopify-klanten.

`CustomerContact` is **Control-Center-owned CRM-data** (net als `Note`/
`Task`), nooit een spiegel van een externe bron. Zie §5 voor waarom een
Shopify-klant niet automatisch een `CustomerContact` wordt.

### 2. `ExternalContactMatch` blijft klantniveau-identiteit — krijgt een optionele `customerContactId`, geen nieuwe identiteitstabel

Drie opties zijn tegen elkaar afgewogen (discovery §3 vroeg dit expliciet):

| Optie | Beoordeling |
|---|---|
| A. `ExternalContactMatch` blijft ongewijzigd, `CustomerContact` volledig los | Verliest het concrete, gevraagde voorbeeld ("piet@jansentuinen.nl → Jansen Tuinen BV → Piet de Vries") — een inkomende e-mail zou nooit automatisch aan een specifieke persoon te herleiden zijn, zelfs niet als die persoon exact als contact geregistreerd staat. |
| **B. `ExternalContactMatch` krijgt een optionele `customerContactId`** | **Gekozen.** Zie onderbouwing hieronder. |
| C. Nieuwe `ContactIdentity`-tabel | Een derde identiteitslaag naast `CustomerProfile` en `ExternalContactMatch` voor exact dezelfde soort informatie (welke externe identiteit hoort bij wie) — precies de "extra identiteitstabel" waar de opdracht expliciet voor waarschuwt. Geen enkel voordeel t.o.v. optie B dat de complexiteit rechtvaardigt. |

**Optie B, met precisie**: `ExternalContactMatch.externalRef` is voor
`source ∈ {TELEFOONSYSTEEM, EMAIL}` altijd al de **contactidentiteit van een
speler** (een genormaliseerd telefoonnummer/e-mailadres) — nooit een
bedrijfsbreed kenmerk. Wanneer die identiteit toevallig **exact** gelijk is
aan een bestaand `CustomerContact.email`/`phone`/`mobile` onder de zojuist
opgeloste `CustomerProfile`, is dat geen giswerk maar een tweede, even
exacte match — dezelfde soort zekerheid als de klant-match zelf. Een
optionele `customerContactId String?` (FK naar `CustomerContact`, nullable)
op de bestaande rij is daarom een natuurlijke, additieve verrijking van een
al bestaande rij, geen nieuwe tabel:

```
model ExternalContactMatch {
  ...bestaande velden ongewijzigd...
  customerContactId String?
  customerContact    CustomerContact? @relation(fields: [customerContactId], references: [id])
}
```

`@@unique([customerProfileId, source, externalRef])` blijft **ongewijzigd**
— de identiteit-sleutel blijft klant+bron+ref; `customerContactId` is
uitsluitend verrijkende metadata op diezelfde rij, nooit onderdeel van de
sleutel (een contactpersoon deelt per definitie dezelfde `externalRef` als
zichzelf, dus er is nooit een reden voor twee rijen met hetzelfde
`(customerProfileId, source, externalRef)` maar een andere
`customerContactId`).

### 3. Kandidaatzoekopdracht wordt uitgebreid: `CustomerProfile` **én** `CustomerContact`

`resolveAndRecordByEmail()`/`resolveAndRecordByPhone()`
(`src/modules/matching/matching.service.ts`) zoeken vandaag uitsluitend in
`CustomerProfile.email`/`phoneNormalized`. Ze worden uitgebreid om **ook**
`CustomerContact.email`/`phone`/`mobile` (niet-gearchiveerd) te doorzoeken,
en de resulterende `CustomerProfile`-kandidaten (via beide paden) te
dedupliceren tot één klant-kandidatenset — de bestaande EXACT/AMBIGUOUS-
logica op klantniveau (ADR-007 rule 2) blijft **ongewijzigd**: nog steeds
nooit stilzwijgend kiezen tussen meerdere klanten. Zodra de klant
eenduidig is (exact één kandidaat, via profiel- of contactmatch), wordt
apart bepaald of de match ook een eenduidige `CustomerContact` opleverde —
zie §4 voor de volledige waarheidstabel.

### 4. Contactniveau-ambiguïteit is een aparte, zwakkere garantie dan klantniveau-ambiguïteit

Klant bekend + contactpersoon **onbekend/ambigu** is een geldige, veilige
eindtoestand — nooit een reden om de klantmatch zelf te verwerpen:

| Scenario | Klant | Contact |
|---|---|---|
| Adres exact op één `CustomerContact`, bij één klant | EXACT | Die contact |
| Adres exact op `CustomerProfile.email` zelf | EXACT | `null` (accounthouder is geen apart `CustomerContact`-record, tenzij iemand er expliciet een aanmaakt — §5) |
| Adres op twee `CustomerContact`-rijen **binnen dezelfde klant** (gedeeld algemeen adres) | EXACT | `null` — persoon ambigu, klant niet |
| Adres op contacts van **verschillende** klanten | AMBIGUOUS (ongewijzigd bestaand gedrag) | niet van toepassing — hele match blijft onbevestigd |
| Adres hoort bij een **gearchiveerde** `CustomerContact` | EXACT (klant blijft bekend) | `null` — nooit automatisch als actieve specifieke contactpersoon gematcht (**gecorrigeerd bij implementatie**, zie hieronder) |

**Correctie bij implementatie (2026-09-03)**: dit ADR beschreef hier
oorspronkelijk "gezet, maar UI onderdrukt het" voor het gearchiveerde-
contact-scenario. De definitieve bouwopdracht voor Phase 4C koos expliciet
voor de striktere variant — `customerContactId` blijft altijd `null` wanneer
de enige overeenkomende contactpersoon gearchiveerd is, in plaats van gezet-
maar-UI-onderdrukt. Dit vermijdt de extra laag "wel opgeslagen, nooit tonen"-
complexiteit en sluit uit dat een toekomstige UI-wijziging per ongeluk een
voormalig contact als actief presenteert. Geïmplementeerd in
`src/modules/matching/matching.service.ts` (`buildCandidateSets()`), volledig
onderbouwd in `docs/build/PHASE-4C-CONTACTS-STAGING.md` §5.

Nooit fuzzy: alleen een exacte, genormaliseerde match op e-mail/telefoon telt
mee — geen naamgelijkenis, geen domeinmatch ("iedereen @jansentuinen.nl is
vast van die klant" wordt **niet** aangenomen, want een gedeeld
domeinsuffix is geen bewijs van een specifieke, geregistreerde
contactpersoon).

### 5. Shopify Customer wordt nooit automatisch `CustomerContact`

Shopify blijft de commerciële klantidentiteit (ADR-002) —
`CustomerContact` is uitsluitend Control-Center-eigen CRM-verrijking.
Automatisch een `CustomerContact`-rij aanmaken voor elke
`CustomerProfile.email` zou een stille duplicatie van dezelfde informatie in
twee modellen creëren (en meteen de vraag oproepen "welke van de twee is
leidend als ze uiteenlopen"). Een medewerker die de accounthouder ook als
expliciet contact wil vastleggen (bv. om een rol/functie te noteren) doet
dat handmatig, zoals elk ander contact.

## Consequenties

- Precies twee schemawijzigingen, beide additief: nieuw model
  `CustomerContact`, nieuwe kolom `ExternalContactMatch.customerContactId`
  (nullable). Geen wijziging aan bestaande kolommen, geen backfill, geen
  breaking change aan de bestaande unique-constraint.
- `matching.service.ts` krijgt uitgebreide kandidaatlogica, maar de
  publieke contractvorm van `MatchResolution` (`unmatched | exact |
  ambiguous`) blijft ongewijzigd op klantniveau — bestaande callers
  (e-mailadapter) hoeven niet aangepast te worden om te blijven werken
  zoals vandaag; ze kunnen optioneel de nieuwe contact-informatie gebruiken.
- Live-federated lookups (Customer 360's e-mail/telefoon-secties) moeten
  apart worden uitgebreid om **ook** contactadressen/-nummers mee te geven
  aan `getMessagesForAddresses()`/`getActivityForPhoneNumbers()` — dit is
  een aanroep-wijziging in de pagina zelf, geen wijziging aan ADR-007/de
  matching-laag. Zonder deze aanpassing zou een correct geregistreerd
  contact nog steeds geen zichtbare e-mails/gesprekken opleveren (zie
  discovery §1.3).
- Timeline-verrijking (welke naam tonen bij een e-mail/gesprek) gebeurt als
  pure, in-memory cross-referentie op al-opgehaalde data — geen nieuwe
  query per timeline-item, in lijn met het bestaande category-B-projectie-
  principe (ADR-008).
