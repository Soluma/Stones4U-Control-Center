# 42 — Phase 5A Build Spec: Customer Identity — Persoon vs. Organisatie

**Status**: Build spec, geen implementatie. Vervolg op
`40-PHASE-5A-CUSTOMER-IDENTITY-DISCOVERY.md`,
`41-PHASE-5A-CUSTOMER-IDENTITY-ARCHITECTURE.md`,
`docs/architecture/ADR-011-CUSTOMER-IDENTITY-TYPE.md`.

## 1. Scope

Eén Phase 5A: datamodel (`customerTypeOverride`, `companyNameConfirmed`),
`effectiveCustomerType()`/`customerDisplayName()`/`customerSecondaryName()`,
sync-guard tegen overschrijven, lazy refresh bij paginabezoek, Customer
360-header, vijftien bestaande call sites omgezet naar de gedeelde helper,
command-palette-aanpassingen, handmatige override-UI, tests. **Niet**:
order-/adres-signalen (architectuurdoc §12), organisatiehiërarchie,
enrichment, merge-engine (instructie §27).

## 2. Migratie

```prisma
enum CustomerType {
  INDIVIDUAL
  ORGANIZATION
}

model CustomerProfile {
  // ...bestaande velden ongewijzigd...
  customerTypeOverride CustomerType?
  companyNameConfirmed Boolean       @default(false)
}
```

Additief: `CREATE TYPE`, twee `ALTER TABLE ... ADD COLUMN` (beide
nullable/default-gewaardeerd). Geen backfill (ADR-011 §2, architectuurdoc
§17/§18).

## 3. Nieuwe/gewijzigde modules

| Bestand | Inhoud |
|---|---|
| `src/modules/crm/customer-identity.ts` (nieuw) | `effectiveCustomerType()`, `customerDisplayName()`, `customerSecondaryName()` — pure functies |
| `src/modules/crm/customer-profile.service.ts` (gewijzigd) | `getOrCreateCustomerProfile()` → hernoemd `syncCustomerIdentityFromShopify()` (met `companyNameConfirmed`-guard, architectuurdoc §4/§9); `getCustomer360()` roept de sync-functie aan met de al-opgehaalde `shopify`-data (architectuurdoc §8); `updateCustomerCrmFields()` accepteert `customerTypeOverride`/`companyName` |
| `src/app/api/customers/[id]/route.ts` (gewijzigd) | `PATCH`-schema uitgebreid met `customerTypeOverride`/`companyName` |
| `src/app/api/customers/resolve/route.ts` | ongewijzigd — roept de (hernoemde) sync-functie aan zoals nu |
| `src/app/(app)/customers/[id]/CustomerHeader.tsx` (gewijzigd) | `customerDisplayName()`/`customerSecondaryName()`, nieuwe `CustomerTypeControl`-component |
| `src/app/(app)/customers/[id]/CustomerTypeControl.tsx` (nieuw) | Klein, inline bewerkbaar klanttype + bedrijfsnaam — zelfde patroon als `CrmStatusControl.tsx`/`AccountManagerControl.tsx` |
| `src/app/(app)/customers/CustomerSearch.tsx` (gewijzigd) | primaire naam via `customerDisplayName()` toegepast op het Shopify-liveresultaat |
| `src/app/api/search/route.ts` (gewijzigd) | `customers`/`contacts`-groepen gebruiken `customerDisplayName()` |
| 15 bestaande call sites (discovery §6) | inline `displayName ?? companyName` → `customerDisplayName()`; elke onderliggende `select`/`include` uitgebreid met `customerTypeOverride` |
| `tests/customer-identity.test.ts` (nieuw) | `effectiveCustomerType`/`customerDisplayName`/`customerSecondaryName`, pure-functietests |
| `tests/customer-profile.test.ts` (gewijzigd) | sync-guard (companyNameConfirmed), lazy-refresh-bij-360-bezoek |

## 4. Betrokken bestaande call sites (uit discovery §6, exacte lijst)

`src/modules/tasks/task.service.ts`, `src/modules/opportunities/
opportunity.service.ts` (2×), `src/modules/opportunities/dashboard.ts`,
`src/modules/crm/customer-contact.service.ts`, `src/modules/appointments/
appointment.service.ts`, `src/modules/activity/timeline.ts`,
`src/integrations/quotes/adapter.ts` (2×), `src/app/api/search/route.ts`
(3×), `src/app/api/appointments/[id]/route.ts`, `src/app/(app)/tasks/
[id]/TaskDetailView.tsx`, `src/app/(app)/tasks/TasksList.tsx`,
`src/app/(app)/page.tsx`, `src/app/(app)/opportunities/[id]/page.tsx`,
`src/app/(app)/opportunities/OpportunitiesBoard.tsx`.

## 5. Routes

| Route | Methode | RBAC | Wijziging |
|---|---|---|---|
| `/api/customers/[id]` | `PATCH` | `requireWriteAccess()` (bestaand) | Schema uitgebreid: `customerTypeOverride: z.enum(["INDIVIDUAL","ORGANIZATION"]).nullable().optional()`, `companyName: z.string().max(200).nullable().optional()` |

Geen nieuwe route — hergebruikt exact de bestaande
`updateCustomerCrmFields()`-mutatieroute (zelfde patroon als
`crmStatus`/`accountManagerId`).

## 6. Permissions

VIEWER: alleen lezen (overal — Customer 360, zoeken, command palette).
AGENT/ADMIN: mogen `customerTypeOverride`/`companyName` wijzigen via de
bestaande `PATCH`-route, exact dezelfde autorisatie als de al bestaande
`crmStatus`/`accountManagerId`-velden op datzelfde endpoint.

## 7. Audit

Geen nieuwe `AuditAction` nodig — `customer_profile.updated` (bestaand)
dekt dit al, `updateCustomerCrmFields()`'s bestaande
`Activity`(`CUSTOMER_PROFILE_UPDATED`)+`AuditEvent`-patroon wordt
ongewijzigd hergebruikt, nu met `customerTypeOverride`/`companyName` als
mogelijke `changes`-sleutels.

## 8. Sync-guard — implementatiedetail

```ts
export async function syncCustomerIdentityFromShopify(shopifyGid: string, shopifyData?: ShopifyCustomerSummary) {
  const shopify = shopifyData ?? (await getShopifyCustomerByGid(shopifyGid));
  if (!shopify) return null;

  const existing = await prisma.customerProfile.findUnique({ where: { shopifyCustomerGid: shopifyGid }, select: { companyNameConfirmed: true } });

  return prisma.customerProfile.upsert({
    where: { shopifyCustomerGid: shopifyGid },
    create: {
      shopifyCustomerGid: shopifyGid,
      displayName: shopify.displayName,
      companyName: shopify.company,
      email: shopify.email,
      phone: shopify.phone,
      phoneNormalized: normalizeDutchPhone(shopify.phone),
      lastSyncedAt: new Date(),
    },
    update: {
      displayName: shopify.displayName,
      companyName: existing?.companyNameConfirmed ? undefined : shopify.company,
      email: shopify.email,
      phone: shopify.phone,
      phoneNormalized: normalizeDutchPhone(shopify.phone),
      lastSyncedAt: new Date(),
    },
  });
}
```

Optionele `shopifyData`-parameter: `getCustomer360()` geeft de al-opgehaalde
`shopify`-data door (architectuurdoc §8, geen dubbele Shopify-call);
`/api/customers/resolve` blijft zonder dit argument aanroepen (haalt zelf
op, ongewijzigd gedrag).

## 9. Teststrategie

**Pure functies** (`tests/customer-identity.test.ts`):
- `effectiveCustomerType`: `companyName` gevuld + geen override →
  `ORGANIZATION`; leeg + geen override → `INDIVIDUAL`; override wint altijd
  in beide richtingen.
- `customerDisplayName`: organisatie toont `companyName`; particulier
  toont `displayName`; ontbrekende `displayName` én `companyName` →
  `"Klant"`-fallback (regressietest tegen de bestaande vijftien plekken se
  gedeelde fallback-waarde).
- `customerSecondaryName`: `null` voor particulier; accounthouder-naam voor
  organisatie; `null` als organisatie geen bekende `displayName` heeft.

**Sync-guard** (`tests/customer-profile.test.ts`, uitgebreid):
- `companyNameConfirmed = false` (standaard): sync overschrijft
  `companyName` met de Shopify-waarde, ook als lokaal al iets anders staat.
- `companyNameConfirmed = true`: sync laat `companyName` volledig met rust,
  ververst `displayName`/`email`/`phone` wél.
- `getCustomer360()` roept de sync aan met de al-opgehaalde
  Shopify-data — geen tweede Shopify-aanroep (query-tellingstest of
  expliciete mock-call-count, zelfde soort controle als elders in dit
  project).

**Manual override** (RBAC):
- VIEWER geblokkeerd op de `PATCH`-route voor deze twee velden (bestaande
  gate, regressietest).
- AGENT/ADMIN kunnen `customerTypeOverride` zetten/wissen en `companyName`
  corrigeren (zet automatisch `companyNameConfirmed = true`).

**Customer 360**:
- INDIVIDUAL: header toont alleen `displayName`, geen "Accounthouder"-regel.
- ORGANIZATION (via override of via gevuld `companyName`): header toont
  `companyName` primair, "Accounthouder: {displayName}" secundair.
- Contactpersonen-sectie zichtbaar in beide gevallen (architectuurdoc §6).

**Search/command palette**:
- `customers`-groep en Shopify-livezoekresultaten tonen `companyName`
  primair zodra bekend.
- `contacts`-groep (Phase 4C) toont de organisatienaam als subtitel i.p.v.
  de rauwe accounthoudersnaam.
- Geen regressie op de bestaande query's/limieten.

**Matching**: expliciete regressietest dat `resolveAndRecordByEmail`/
`Phone` (Phase 3a/4C) ongewijzigd werken — geen enkele afhankelijkheid van
`customerType`/`companyName` geïntroduceerd.

## 10. Kwaliteitspoorten

`npm run test && npm run typecheck && npm run lint && npm run build` — alle
vier groen vereist, nieuwe testbaseline t.o.v. de huidige 451 gerapporteerd.

## 11. Buildvolgorde

1. Migratie + `effectiveCustomerType()`/`customerDisplayName()`/
   `customerSecondaryName()` + volledige pure-functietestdekking (laagste
   risico, geen afhankelijkheden).
2. Sync-guard (`companyNameConfirmed`) + hernoeming naar
   `syncCustomerIdentityFromShopify()` + `getCustomer360()`-integratie +
   tests.
3. `PATCH /api/customers/[id]`-uitbreiding + `CustomerTypeControl.tsx` +
   RBAC-tests.
4. Customer 360-header (`CustomerHeader.tsx`).
5. De vijftien bestaande call sites (discovery §6) — mechanisch,
   laag-risico, laatst omdat het de breedste (maar ondiepste) wijziging is.
6. Command-palette-aanpassingen (`customers`/`contacts`-groepen).
7. Volledige kwaliteitspoorten.

## 12. Open beslissingen — input van Fons nodig

1. **UX-precisie van de "Accounthouder"-regel** (architectuurdoc §5): exact
   label/positionering in de header — een cosmetische keuze, geen
   architecturale blokkade.
2. **`CustomerTypeControl.tsx`-interactiepatroon**: een simpele
   select-toggle (Particulier/Zakelijk) zoals `CrmStatusControl.tsx`, of
   iets uitgebreider (met een "terug naar automatisch"-optie om
   `customerTypeOverride` weer op `null` te zetten)? Aanbeveling: wel een
   expliciete "automatisch (afgeleid)"-optie, zodat een verkeerde
   handmatige override altijd terug te draaien is zonder de onderliggende
   `companyName` te hoeven wissen.
3. **Order-/adressignalen (architectuurdoc §12)**: bevestigd niet in 5A,
   maar kan bij voldoende bewijs van bruikbare data alsnog worden
   heroverwogen in een latere fase.

Geen van deze drie is blokkerend voor het starten van de bouw.

## 13. Eindconclusie

Phase 5A is volledig additief (twee nullable/default-kolommen, één enum,
geen backfill), introduceert geen nieuwe identiteitslaag, en raakt geen
enkele bestaande matching-/CustomerContact-/Opportunity-semantiek. De
grootste implementatie-inspanning is presentatie-breed (vijftien call
sites) maar mechanisch en laag-risico — geen nieuwe query's, alleen een
gedeelde helper-functie die een al bestaand, consistent
(zij het verkeerd-om) patroon vervangt.
