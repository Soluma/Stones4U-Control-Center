# 41 — Phase 5A Architecture: Customer Identity — Persoon vs. Organisatie

**Status**: Architectuurvoorstel, geen implementatie. Vervolg op
`40-PHASE-5A-CUSTOMER-IDENTITY-DISCOVERY.md`. Het identiteitsvraagstuk
(`customerType`/`companyName`-source-of-truth) is vastgelegd in
`docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md` — dit document herhaalt
die beslissing niet, maar bouwt erop voort.

## 1. Datamodel

```prisma
enum CustomerType {
  INDIVIDUAL
  ORGANIZATION
}

model CustomerProfile {
  // ...bestaande velden ongewijzigd...
  customerTypeOverride  CustomerType?
  companyNameConfirmed  Boolean       @default(false)
}
```

Twee nieuwe, nullable/default-gewaardeerde kolommen, één nieuwe enum — zie
ADR-011 §1/§2 voor de volledige onderbouwing. Geen `accountHolderName`
(ADR-011 §4).

## 2. `effectiveCustomerType()` en `customerDisplayName()`

```ts
// src/modules/crm/customer-identity.ts (nieuw, pure functies — geen DB-toegang,
// zelfde positionering als src/modules/opportunities/attention.ts)

export function effectiveCustomerType(profile: {
  companyName: string | null;
  customerTypeOverride: CustomerType | null;
}): CustomerType {
  return profile.customerTypeOverride ?? (profile.companyName ? "ORGANIZATION" : "INDIVIDUAL");
}

/** De naam die overal als PRIMAIRE klantnaam getoond wordt — vervangt de
 * vijftien plekken die vandaag `displayName ?? companyName` dupliceren
 * (discovery §6). */
export function customerDisplayName(profile: {
  displayName: string | null;
  companyName: string | null;
  customerTypeOverride: CustomerType | null;
}): string {
  if (effectiveCustomerType(profile) === "ORGANIZATION" && profile.companyName) {
    return profile.companyName;
  }
  return profile.displayName ?? profile.companyName ?? "Klant";
}

/** De ONDERGESCHIKTE naam — voor een organisatie de accounthouder, voor
 * een particulier niets extra's (de displayName is dan al de primaire naam). */
export function customerSecondaryName(profile: {
  displayName: string | null;
  companyName: string | null;
  customerTypeOverride: CustomerType | null;
}): string | null {
  if (effectiveCustomerType(profile) === "ORGANIZATION" && profile.companyName) {
    return profile.displayName;
  }
  return null;
}
```

Beide functies zijn triviaal, puur, en losstaand testbaar — geen nieuwe
query, want elke bestaande call site selecteert `displayName`/`companyName`
al (discovery §6). De vijftien bestaande inline-expressies worden
vervangen door een import van `customerDisplayName()`.

## 3. Waarheidstabel — organisatie-detectie

| Signaal | Betrouwbaar? | Gebruik |
|---|---|---|
| Shopify `defaultAddress.company` niet-leeg | Ja | Automatische `ORGANIZATION`-afleiding (via `effectiveCustomerType()`) |
| Expliciete Shopify B2B `Company`-relatie | Ja (indien ooit actief — vandaag niet, discovery §3) | Zelfde behandeling als hierboven, indien later geactiveerd |
| Menselijke CRM-keuze (`customerTypeOverride`) | Ja — wint altijd | Directe override |
| Zakelijk ogend e-maildomein | **Nee** | Nooit gebruikt |
| Achternaam-patroon/woorden als "groep"/"BV" in de naam | **Nee** | Nooit gebruikt |
| Orderbedrag/aantal orders | **Nee** | Nooit gebruikt |
| Historische order-`shippingAddress.company`/`billingAddress.company` | Onbewezen dekking (discovery §2/§3) | Zie §12 hieronder — categorie B (suggestie), niet automatisch, **niet gebouwd in 5A** |

## 4. `companyName`-bescherming tegen synchronisatie

`customer-profile.service.ts`'s sync-upsert (huidige naam
`getOrCreateCustomerProfile()`, zie discovery §4) wordt:

```ts
update: {
  displayName: shopify.displayName,
  companyName: profile?.companyNameConfirmed ? undefined : shopify.company,
  email: shopify.email,
  phone: shopify.phone,
  phoneNormalized: normalizeDutchPhone(shopify.phone),
  lastSyncedAt: new Date(),
},
```

(`undefined` in een Prisma `update`-object laat het bestaande veld
ongemoeid — geen aparte if/else-tak nodig.) Vereist het bestaande profiel
vooraf op te halen om `companyNameConfirmed` te kennen — één extra,
geïndexeerde `findUnique` op `shopifyCustomerGid`, verwaarloosbare kosten
t.o.v. de Shopify-round-trip die deze functie toch al maakt.

## 5. Individual vs. organisatie — Customer 360-header

**INDIVIDUAL**:
```
Sjoerd Keltjens                    [CrmStatus-badge]
Particulier · sjoerd@... · 06...
```

**ORGANIZATION**:
```
Jansen Tuinen BV                   [CrmStatus-badge]
Zakelijke klant · Accounthouder: Jan Jansen · info@... · 06...
```

Geen aparte "Particulier"-badge nodig als visuele ruis vermeden moet worden
— het woord verschijnt al in de bestaande detailregel, consistent met hoe
`shopify.company` daar vandaag al staat (discovery §5). `CustomerHeader.tsx`
gebruikt `customerDisplayName()` voor de `<h1>`, en toont
`customerSecondaryName()` (indien niet-null) als "Accounthouder: {naam}" in
de detailregel, vóór e-mail/telefoon.

## 6. Contactpersonen-sectie — geen harde koppeling aan `customerType`

Instructie §10 vraagt expliciet om geen harde DB-beperking. `ContactsSection`
(Phase 4C) blijft **altijd** zichtbaar, ongeacht `effectiveCustomerType()`
— voor een `INDIVIDUAL`-klant simpelweg meestal leeg (een particulier heeft
zelden een "contactpersoon" nodig), maar een uitzondering (bv. een
particuliere klant die via een familielid communiceert) blijft mogelijk
zonder eerst het klanttype te moeten wijzigen. Geen wijziging aan
`ContactsSection.tsx` nodig — het gedrag is al precies dit (render altijd,
leeg is een geldige staat).

## 7. Primary contact vs. Shopify-accounthouder — bevestigd

Bevestigd, zoals de opdracht al voorstelde (§11): **geen** automatische
`CustomerContact`-aanmaak voor de Shopify-accounthouder. Customer 360 toont
de accounthouder voortaan wél duidelijk gelabeld (§5 hierboven,
`customerSecondaryName()`) — volledig los van de expliciet door een mens
beheerde `CustomerContact`-lijst. Twee onafhankelijke concepten, geen
overlap, geen dubbele registratie.

## 8. Lazy refresh — sync bij elk paginabezoek, geen nieuwe Shopify-aanroep

Discovery §4's kernvondst: `getCustomer360()` haalt de live Shopify-klant
al op bij elk bezoek, zonder terug te schrijven. Voorstel: laat
`getCustomer360()` de bestaande sync-functie aanroepen met de **al
opgehaalde** `shopify`-data (geen tweede Shopify-call) in plaats van
uitsluitend `prisma.customerProfile.findUnique()`. Effect: de lokale
snapshot (inclusief `companyName`, met de `companyNameConfirmed`-guard
uit §4) blijft actueel bij gewoon browsen, niet alleen bij een hernieuwde
Shopify-zoekactie. Geen achtergrondproces nodig (instructie §26 sluit dit
uit tenzij noodzakelijk) — puur lazy/on-read, exact zoals gevraagd.

## 9. `syncCustomerIdentityFromShopify()` — hernoemen, niet herbouwen

`getOrCreateCustomerProfile()` doet vandaag al 90% van wat instructie §26
vraagt. Voorstel: een dunne naamswijziging/hernoeming
(`syncCustomerIdentityFromShopify(shopifyGid)`) om de functie expliciet als
"de ene, centrale identity-sync" te positioneren, met de
`companyNameConfirmed`-guard (§4) als enige gedragswijziging. Geen aparte,
nieuwe functie — voorkomt twee subtiel verschillende sync-paden.

## 10. Customer 360 / lijst / zoeken / command palette

`CustomerSearch.tsx` (Shopify-livezoekresultaten): title =
`customerDisplayName()`-equivalent toegepast op het **live** Shopify-object
(geen `customerTypeOverride` beschikbaar voor een nog niet
geresolved profiel — valt dan terug op de afgeleide waarde, wat correct is
zolang er geen menselijke override kán bestaan). Command palette
`customers`-groep: zelfde patroon, nu via de al-bestaande
`customerProfileId`-koppeling waar beschikbaar (dan wél met een eventuele
`customerTypeOverride` uit de lokale rij).

Command palette `contacts`-groep (Phase 4C, al gebouwd): subtitel wordt
`customerDisplayName()` in plaats van het rauwe
`c.customerProfile.displayName ?? c.customerProfile.companyName` — een
kleine, gerichte aanpassing aan reeds bestaande code (geen herbouw), die
instructie §17's expliciete eis oplost: "Piet de Vries — Jansen Tuinen BV"
in plaats van "Piet de Vries — Jan Jansen."

## 11. Opportunities/taken/afspraken/quotes-weergave

Alle vijftien plekken uit discovery §6 vervangen hun inline
`displayName ?? companyName`-expressie door `customerDisplayName()`. Geen
nieuwe query nodig (alle plekken selecteren `companyName` al) — wel moet
elke bestaande `select`/`include` uitgebreid worden met
`customerTypeOverride` (klein, mechanisch, geen risico) zodat een
menselijke override ook buiten Customer 360 correct doorwerkt.

Opportunity blijft bij `CustomerProfile` horen (ongewijzigd,
architectuurdoc-bevestiging van instructie §18) — geen
`OpportunityContact`, geen wijziging aan het Phase 4A/4B-datamodel.

## 12. Orders/adressen als signaal — categorie C, niet gebouwd in 5A

Instructie §12/§13 vraagt een expliciete keuze: A (bron voor automatische
identiteit), B (suggestie), of C (alleen context). **Voorstel: geen van
drie bouwen in Phase 5A.** Order-niveau `company`-velden zijn (voor zover
gecontroleerd, discovery §2/§3) even leeg als het klantprofiel zelf — de
marginale waarde van een tweede signaalbron is onbewezen, terwijl het wel
degelijk governance-vragen oproept (welke order is leidend bij
tegenstrijdige waarden — meest recente? meerderheid?). Uitgesteld tot een
concreet gebruiksgeval dit aantoont — consistent met hoe dit project
elders al omgaat met onbewezen complexiteit (bv. Phase 4B §19's
achtergrondproces-afweging).

## 13. Matching — bevestigd ongewijzigd

Geverifieerd tijdens discovery (§7): `matching.service.ts` heeft geen
enkele afhankelijkheid van `companyName`/`customerType`. Dit blijft zo —
matching blijft uitsluitend op Shopify GID, genormaliseerde e-mail,
genormaliseerd telefoon (ADR-007, ongewijzigd door dit voorstel).

## 14. Duplicatie/merge — bevestigd, geen nieuwe machinerie

Instructie §20's scenario (Shopify kent "Jan Jansen", CRM ontdekt later
"Jansen Tuinen BV") vereist **geen** nieuw mechanisme: het is hetzelfde
`CustomerProfile` (dezelfde `shopifyCustomerGid`), dat simpelweg van
persoons- naar organisatieweergave overgaat zodra `companyName` gevuld
raakt (automatisch via sync) of een mens `customerTypeOverride` zet. Geen
merge-engine, geen tweede profiel, geen identiteitswijziging — puur een
presentatie-consequentie van `effectiveCustomerType()`.

## 15. Company-velddatakwaliteit — bevindingen

Zie discovery §2 voor de volledige, met echte (read-only) Shopify-queries
onderbouwde bevindingen: `company` is bij alle drie bekende
productieklanten en een steekproef van 10 willekeurige andere
Shopify-klanten leeg, zowel op klant- als orderniveau (voor de ene
gecontroleerde klant). Geen aanwijzing van wisselende bedrijfsnamen per
order of een company-veld dat per ongeluk een persoonsnaam bevat — er is
simpelweg (nog) te weinig data om zo'n patroon te kunnen beoordelen.

## 16. RBAC / audit

`customerTypeOverride` en `companyNameConfirmed` zijn nieuwe CRM-owned
mutable state — zelfde behandeling als de bestaande `crmStatus`/
`accountManagerId` in `updateCustomerCrmFields()`: VIEWER read-only,
AGENT/ADMIN mogen wijzigen, `Activity` (CUSTOMER_PROFILE_UPDATED, bestaand
type, geen nieuwe nodig) + `AuditEvent` (bestaande `customer_profile.updated`
actie, geen nieuwe nodig — deze twee velden zijn gewoon nieuwe `changes` op
dezelfde, al bestaande mutatiefunctie).

## 17. Migratie-impact

Twee nieuwe, nullable/default-gewaardeerde kolommen + één nieuwe enum op
een reeds bestaand model — additief, geen bestaande kolom gewijzigd. Zie
ADR-011 §2 voor de volledige onderbouwing waarom geen backfill nodig is:
bestaande rijen vallen vanzelf, correct terug op de afgeleide waarde
(`customerTypeOverride = null` → afgeleid uit het al aanwezige
`companyName`).

## 18. Backfill-strategie

**Geen migratie-tijd-backfill.** Instructie §24 is expliciet: een migratie
mag geen Shopify-API nodig hebben. Omdat `effectiveCustomerType()` zonder
backfill al correct werkt (leeg `customerTypeOverride` + bestaand
`companyName` volstaat), is er ook geen enkele noodzaak voor een
lazy-on-read-backfill van het klanttype zelf — alleen `companyName`/
`displayName`/etc. blijven zoals nu lazy ververst (via §9's sync-functie,
ongewijzigd qua trigger-moment op het bestaande gedrag, uitgebreid met §8's
extra trigger-punt).

## 19. Schaal-overweging

Ontworpen zonder aanname over een kleine database: `effectiveCustomerType()`
en `customerDisplayName()` zijn pure, kolom-lokale functies (geen join,
geen aggregatie) — schalen identiek bij drie of drieduizend
`CustomerProfile`-rijen. De enige databasewijziging is twee kolommen op een
al bestaande, al geïndexeerde tabel.
