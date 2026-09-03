# ADR-011 — Customer identity: persoon vs. organisatie, source-of-truth

**Status**: Voorgesteld (2026-09-04), onderdeel van Phase 5A-discovery. Nog
niet geïmplementeerd.

## Context

`CustomerProfile` (ADR-002) representeert vandaag elke klant identiek,
ongeacht of het een particulier of een organisatie is — `displayName` (de
Shopify-accounthouder's persoonsnaam) is overal in de applicatie de
primaire klantnaam, ook wanneer `companyName` gevuld is. Zie
`docs/platform-discovery/40-PHASE-5A-CUSTOMER-IDENTITY-DISCOVERY.md` voor de
volledige inventarisatie — met name §2 (companyName is leeg omdat de
Shopify-brondata leeg is, geen leesbug) en §6 (vijftien plekken in de
applicatie herhalen hetzelfde `displayName ?? companyName`-patroon).

Twee vragen vergen een echte architectuurbeslissing:

1. Hoe wordt bepaald of een klant een persoon of een organisatie is, zonder
   te gokken (geen e-maildomein-analyse, geen naamherkenning)?
2. Hoe blijft een handmatige CRM-correctie (bedrijfsnaam, klanttype)
   overeind bij de volgende Shopify-synchronisatie, zonder twee
   tegenstrijdige bronnen van waarheid te creëren?

## Besluit

### 1. Geen opgeslagen `customerType` als primaire waarheid — een afgeleide, override-baar berekende waarde

`customerType` wordt **niet** een verplicht, altijd-ingevuld databaseveld
dat bij aanmaak "geraden" moet worden. In plaats daarvan:

```ts
function effectiveCustomerType(profile: {
  companyName: string | null;
  customerTypeOverride: CustomerType | null;
}): "INDIVIDUAL" | "ORGANIZATION" {
  return profile.customerTypeOverride ?? (profile.companyName ? "ORGANIZATION" : "INDIVIDUAL");
}
```

Exact hetzelfde patroon als het al bewezen `effectiveProbability()`
(`src/modules/opportunities/labels.ts`, ADR-009) — een expliciete
menselijke keuze wint altijd; zonder die keuze valt de functie terug op het
enige betrouwbare signaal dat we vandaag hebben: **is Shopify's eigen
`company`-veld gevuld.** Dat is geen gok — het is de enige structurele,
door de klant zelf (via Shopify checkout/adresinvoer) ingevoerde indicatie
die we bezitten. Een leeg `company`-veld is geen bewijs van "particulier",
maar bij afwezigheid van enig ander signaal is dat de veiligste, laagste-
impact default (nooit gebruikt om automatisch iets te muteren — zie §5).

**Nooit toegestaan als classificatiesignaal** (bevestigd tijdens discovery,
§13 van de bouwopdracht): e-maildomein, achternaam-patronen, woorden als
"groep"/"BV" in de naam, orderbedrag. Deze zijn expliciet **niet**
"betrouwbare brondata" in de zin van dit besluit.

### 2. `companyName` blijft Shopify-owned, met een expliciete confirmatie-vlag om overschrijven te voorkomen

Geen tweede, parallelle "override"-tekstveld (dat zou een tweede bron van
waarheid voor dezelfde informatie creëren — exact wat vermeden moet
worden). In plaats daarvan één nieuwe boolean:
`companyNameConfirmed: Boolean @default(false)`.

- `false` (standaard): `companyName` blijft bij elke sync onvoorwaardelijk
  overschreven met Shopify's waarde — huidig gedrag, ongewijzigd.
- `true` (gezet zodra een mens de waarde in de CRM-UI bevestigt of
  corrigeert): de sync-functie slaat `companyName` voortaan over — de
  overige Shopify-eigen velden (`displayName`/`email`/`phone`) blijven wél
  gewoon verversen.

Dit lost het door de opdracht expliciet genoemde risico op ("medewerker
zet bedrijf correct → volgende Shopify-read wist het weer") met één
minimale, additieve kolom, zonder een tweede tekstveld te introduceren.

### 3. `customerTypeOverride` is 100% Control-Center-owned — geen syncrisico

In tegenstelling tot `companyName` heeft Shopify geen "klanttype"-concept
om ooit mee te overschrijven — `customerTypeOverride` wordt nooit door een
Shopify-sync aangeraakt, dus is er hier structureel geen bron-conflict
mogelijk (in tegenstelling tot `companyName`, dat wél een Shopify-tegenhanger
heeft).

### 4. Geen apart `accountHolderName`-veld

`CustomerProfile.displayName` (of, live, `shopify.displayName`) **is** de
naam van de Shopify-accounthouder — voor een `ORGANIZATION`-klant is dat
exact de waarde die als "Accounthouder: {naam}" getoond moet worden. Een
nieuw veld zou een letterlijke duplicaat zijn van data die al bestaat; het
enige dat verandert is welk veld **primair** getoond wordt, afhankelijk van
`effectiveCustomerType()` (zie architectuurdoc §7 voor de UX-uitwerking).

## Consequenties

- Twee nieuwe, beide nullable/default-gewaardeerde kolommen op
  `CustomerProfile`: `customerTypeOverride CustomerType?`,
  `companyNameConfirmed Boolean @default(false)`. Eén nieuwe enum
  `CustomerType { INDIVIDUAL, ORGANIZATION }`. Geen bestaande kolom
  gewijzigd, geen backfill nodig — bestaande rijen vallen automatisch en
  correct terug op de afgeleide waarde.
- Vijftien bestaande plekken die vandaag `displayName ?? companyName`
  dupliceren, worden vervangen door één gedeelde `customerDisplayName()`-
  helper die `effectiveCustomerType()` gebruikt — een presentatie-only
  wijziging, geen nieuwe query nodig (alle vijftien plekken selecteren
  `companyName` al).
- `getOrCreateCustomerProfile()`/de sync-functie krijgt de
  `companyNameConfirmed`-guard; `getCustomer360()` kan voortaan ook
  synchroniseren met de Shopify-data die het toch al live ophaalt voor
  weergave — nul nieuwe Shopify-aanroepen (zie architectuurdoc §8/§9).
- Matching (ADR-007), `CustomerContact` (ADR-010), en Opportunity-koppeling
  (ADR-009) blijven volledig ongewijzigd — `customerType`/`companyName`
  hebben geen enkele rol in identiteitsmatching, uitsluitend in presentatie.
