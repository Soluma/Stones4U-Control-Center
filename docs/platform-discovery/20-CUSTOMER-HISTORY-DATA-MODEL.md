# 20 — Customer History datamodel (TelefoonSysteem)

Bron: `D:\Shopify\TelefoonSysteem\prisma\customer-history.schema.prisma`, `apps/api/src/lib/prismaHistory.ts`, `apps/api/src/routes/customerHistory.ts`, `apps/api/src/services/customerHistoryService.ts`, plus een repo-brede grep naar elk ander gebruik van `prismaHistory`/`customerHistory`/`ExactCustomer*`.

## 0. Cruciale correctie op een eerdere aanname

**"Customer History" in TelefoonSysteem is géén gespreks-/interactiehistorie.** Ondanks de naam `customer-history-db`/`CUSTOMER_HISTORY_DATABASE_URL` bevat dit schema uitsluitend **Exact Online (boekhoudsoftware)-synchronisatiedata**: klanten, facturen, factuurregels, een e-mail-koppeltabel, en een importrun-log. Er zitten **geen** gesprekken, notities of taken in deze database. De UI zelf noemt het "Exact historie" (`apps/web/src/components/calls/IncomingCallPopup.tsx:157,173`), en de API geeft de foutmelding `'Exact-historie tijdelijk niet beschikbaar'` (`customerHistory.ts:30`) terug.

**Dit corrigeert eerdere discovery-documenten** ([02-DATA-MODEL-MAP.md](02-DATA-MODEL-MAP.md), [08-ACCESS-GAPS.md](08-ACCESS-GAPS.md), [09-EXECUTIVE-SUMMARY.md](09-EXECUTIVE-SUMMARY.md), [15-CRM-GAP-ANALYSIS.md](15-CRM-GAP-ANALYSIS.md)), die op basis van alleen Fly-secretsnamen veronderstelden dat `customer-history-db` "vermoedelijk klant/interactie-records" bevat en een goede kandidaat zou zijn voor de CRM Customer Timeline. **Dat is niet zo.** De daadwerkelijke gespreks-/contact-/taakdata leeft in een **volledig andere database**: het hoofdschema `prisma/schema.prisma`, bereikt via `DATABASE_URL`, niet `CUSTOMER_HISTORY_DATABASE_URL`. Zie [19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md](19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md) voor die data.

## 1. Datamodel (`prisma/customer-history.schema.prisma`, volledig gelezen)

Datasource: `provider = "postgresql"`, `url = env("CUSTOMER_HISTORY_DATABASE_URL")`.

| Model | PK | Belangrijke velden | Opmerkingen |
|---|---|---|---|
| `ExactCustomer` | `id String @id` | `customerNumber, displayName, companyName, email, normalizedEmail, phone, normalizedPhone, city` (alle optioneel) | **Geen `@unique`** op `email`/`phone`/`normalizedEmail`/`normalizedPhone`. Geen timestamps, geen statusveld. |
| `ExactInvoice` | `id String @id` | `customerId, exactCustomerId, invoiceNumber, invoiceDate, status, totalAmount (Decimal), outstandingAmount (Decimal), createdAt` | Twee parallelle mogelijke FK-kolommen (`customerId` vs `exactCustomerId`) — het schema hedget over welke de echte database daadwerkelijk gebruikt. |
| `ExactInvoiceLine` | `id String @id` | `customerId, exactCustomerId, sku, itemCode, title, description, quantity (Decimal), totalAmount (Decimal), lineTotal (Decimal)` | Zelfde dubbele-FK-hedge. |
| `ExactCustomerEmailLink` | `id String @id` | `exactCustomerId, email, normalizedEmail` | Koppeltabel om een Exact-klant via een alternatief e-mailadres te vinden. |
| `ExactImportRun` | `id String @id` | `startedAt, completedAt, status` | Volgt de batch-syncjob die deze DB vult vanuit Exact Online — de importjob zelf is extern, niet in deze repo. |

Geen enkele Prisma `@relation` is gedeclareerd — elke join gebeurt handmatig in raw SQL in de servicelaag (zie §5), vandaar de dubbele-FK-hedge per kindtabel.

## 2. Primaire sleutels & Shopify-identifiers

Alle PK's zijn losse strings (`id String @id`, geen cuid/autoincrement-conventie zichtbaar in dit schema). **Geen enkel veld verwijst naar Shopify** — geen `shopifyCustomerId`, geen GID. Dit schema is uitsluitend een Exact Online-spiegel, volledig onafhankelijk van Shopify-identiteit.

## 3. E-mail/telefoon-matching

Twee normalisatielagen bestaan, **niet identiek**:

- **`customerHistoryService.ts:74-84`** (voor deze database): `normalizeEmail` = `trim().toLowerCase()`. `normalizePhone` = strip alleen witruimte/streepjes/haakjes (`replace(/[\s\-()]/g, '')`) — **geen E.164-conversie, geen omzetting van voorloop-nul/landcode.**
- **`shopifyService.ts:78-117`** (voor Shopify-telefoonlookups, zie [19](19-TELEFOONSYSTEEM-CRM-DEEP-DIVE.md)) is veel geavanceerder: genereert meerdere kandidaat-formaten inclusief Nederlandse `0`↔`+31`↔`31`↔`0031`-conversies.

**Praktisch gevolg**: als Exact een nummer als `+31612345678` opslaat en de PBX levert `0612345678`, matcht `getCustomerByPhone` **niet** — de Exact-historie-matching heeft geen Nederlandse belformaat-normalisatie, in tegenstelling tot de Shopify-kant.

## 4. Order-/factuurhistorie

Dit schema bevat volledige Exact-boekhouddata: facturen (`ExactInvoice`), factuurregels (`ExactInvoiceLine` — SKU's, aantallen, bedragen). Omzet-aggregatie wordt in-app berekend: `getCustomerRevenueSummary` (regels 353-372: som van factuurtotalen, openstaand bedrag, laatste factuurdatum) en `getMostPurchasedItemsForCustomer` (regels 383-423: SQL `GROUP BY` voor best verkochte SKU's per klant).

## 5. Interactiehistorie

**Geen.** Deze database bevat nul gespreks-, notitie- of taakrecords. "Interactie" in de zin van de opdracht bestaat alleen in het hoofdschema van TelefoonSysteem (Call/CallNote/Task/Contact), niet hier.

## 6. Welke database wordt gelezen, welke geschreven

**Gelezen**: uitsluitend `CUSTOMER_HISTORY_DATABASE_URL` (Exact-historie).
**Geschreven**: **niets** — geverifieerd, niet aangenomen. Zie §7.

## 7. Klopt "Customer History Database read-only" nog? — JA, geverifieerd

- `prismaHistory.ts:5-11` bevat het commentaar: *"Read-only Prisma client for customer-history-db ... Do NOT write to this database."*
- Elke query loopt via `queryRows()` (`customerHistoryService.ts:206-210`), een dunne wrapper om `prismaHistory.$queryRawUnsafe(query, ...params)` — en **elke SQL-string die hierin wordt doorgegeven is een `SELECT`** (geverifieerd in `getCustomerByEmail`, `getCustomerByPhone`, `getRecentInvoicesForCustomer`, `getRecentInvoiceLinesForCustomer`, `getMostPurchasedItemsForCustomer`). Geen enkele `INSERT`/`UPDATE`/`DELETE`/Prisma-schrijfcall tegen `prismaHistory` bestaat ergens in de repo.
- De routes (`customerHistory.ts`) exposen alleen `GET`-endpoints — geen `POST`/`PUT`/`PATCH`/`DELETE`.
- **`apps/ami-worker` gebruikt deze database helemaal niet** — de realtime call-verrijking praat uitsluitend met Shopify, nooit met Exact.

Beide GET-routes vereisen `requireAuth` (geldig JWT) maar **geen specifieke rol** — elke ingelogde medewerker kan dit opvragen.

## 8. Caching

Geen. Geen in-memory cache, geen Redis. De routes schakelen HTTP-caching expliciet uit (`Cache-Control: no-store, no-cache, must-revalidate...`). Elk verzoek gaat rechtstreeks naar Postgres.

## 9. Fallback-logica

Gelaagde fallback, expliciet in `getCustomerHistoryForCaller` (regels 521-605):
1. Als `CUSTOMER_HISTORY_DATABASE_URL` niet gezet is, is `prismaHistory` `null` en geeft de functie meteen `{ found: false, unavailable: true }` terug — de route vertaalt dit naar HTTP 503.
2. Als een e-mailadres is meegegeven, wordt **alleen** dat geprobeerd — expliciet commentaar: "We intentionally do not fall back to phone in this path." Zelfs als de e-mail-lookup niets vindt, wordt telefoon in die tak NIET als tweede poging geprobeerd.
3. Alleen als geen e-mail is meegegeven, wordt telefoon geprobeerd.
4. Binnen elke lookup zit een **kandidaat-queryketen** (`firstSuccessfulQuery`, regels 212-222) die tot 3 verschillende SQL-vormen per opzoeking probeert en de eerste met resultaten gebruikt — dit is defensieve codering tegen schema-drift, geen business-fallback.

## 10. Risico op dubbele klantidentiteiten — reëel, geen dedup-logica

- **Geen `@unique`-constraint** op `ExactCustomer.email`, `normalizedEmail`, `phone`, of `normalizedPhone` — Postgres staat probleemloos meerdere `ExactCustomer`-rijen met hetzelfde genormaliseerde telefoonnummer/e-mailadres toe.
- Alle lookup-queries gebruiken `LIMIT 1` **zonder `ORDER BY`** — bij duplicaten geeft Postgres een niet-deterministische, willekeurige rij terug; dezelfde beller kan bij verschillende opzoekingen een andere factuurhistorie te zien krijgen.
- Repo-brede zoekopdracht naar merge/dedup-logica leverde niets op voor deze database.

## 11. Kan dit systeem later als bron dienen voor CRM Customer Timeline?

**Gedeeltelijk ja, met duidelijke beperkingen — en NIET voor de "interactie"-tijdlijn zelf (die data staat hier niet).**

**Wel bruikbaar**:
- Als bron voor **historische facturatie/omzet** in een Customer 360-scherm (`ExactInvoice`/`ExactInvoiceLine` — bedragen, openstaand saldo, meest gekochte artikelen). Dit is precies het soort data dat de CRM-wens "totale orderwaarde"/"openstaande betalingen" nodig heeft, en het bestaat al, read-only, herbruikbaar via API-aanroep zonder deze database zelf aan te raken.
- Het read-only-ontwerp zelf (aparte Prisma-client, expliciet "nooit schrijven"-commentaar) is een goed patroon om te kopiëren voor andere externe boekhoud-/ERP-koppelingen.

**Niet bruikbaar / vereist eerst reparatie**:
- Geen Shopify-koppeling — een CRM zou zelf moeten combineren met Shopify's `customer.id`/GID (via e-mail/telefoon-matching, met dezelfde risico's als hierboven beschreven).
- Telefoonnormalisatie is te zwak voor betrouwbare matching op basis van een PBX-afkomstig nummer — zou eerst dezelfde Nederlandse-belformaat-normalisatie moeten krijgen als de Shopify-matching-code elders in TelefoonSysteem gebruikt.
- Geen dedup-garantie — een CRM die dit rechtstreeks bevraagt, loopt het risico om willekeurig de verkeerde (van meerdere) `ExactCustomer`-rij te tonen.
- Is een **losstaande, aparte database** — een CRM zou dit via een nieuwe, eigen read-only-integratie moeten benaderen (zelfde architectuur als TelefoonSysteem's `prismaHistory`-client), niet via directe koppeling aan TelefoonSysteem's hoofddatabase.

**Aanbeveling**: behandel dit als een **losse, optionele verrijkingsbron** voor het CRM (facturatiegeschiedenis), niet als bron voor de interactietijdlijn. Zie [22-CUSTOMER-IDENTITY-STRATEGY.md](22-CUSTOMER-IDENTITY-STRATEGY.md) voor hoe dit past in de bredere identiteitsstrategie.
