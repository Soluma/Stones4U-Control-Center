# Phase 3C-A — Microsoft 365 e-mailintegratie: build report

**Status**: code volledig gebouwd, getest (typecheck/lint/test/build allemaal groen), **niet gedeployed**. Staging-deploy is geblokkeerd op een externe, niet-technische afhankelijkheid — zie §7. Niets gecommit, niets gepusht, geen productie-actie.

Vervolg op `docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` (architectuur/ontwerp), ADR-007 (customer matching) en ADR-008 (externe communicatie/timeline). Dit document beschrijft wat daadwerkelijk gebouwd is, niet nogmaals het ontwerp — zie doc 30 voor de volledige redenering.

## 1. Datamodel / migratie

Eén additieve migratie, `20260903065145_phase_3c_a_email_integration`, handmatig geïnspecteerd vóór toepassing:

```sql
CREATE TYPE "EmailProvider" AS ENUM ('MICROSOFT365', 'IMAP');
ALTER TYPE "MatchSource" ADD VALUE 'EMAIL';
CREATE TABLE "MonitoredMailbox" ( ... );
CREATE UNIQUE INDEX "MonitoredMailbox_emailAddress_key" ON "MonitoredMailbox"("emailAddress");
```

Geen `DROP COLUMN`, geen `DROP TABLE`, geen destructieve hernoeming, geen bestaande data gewijzigd — uitsluitend `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`ALTER TYPE ... ADD VALUE`. Toegepast op de lokale ontwikkel-database; **niet** op staging/productie (die vereisen een aparte, expliciet te autoriseren `prisma migrate deploy`-stap zodra staging daadwerkelijk gedeployed wordt).

`MonitoredMailbox` bevat exact de gevraagde minimale velden (`id`, `emailAddress`, `displayName`, `provider`, `enabled`, `createdAt`, `updatedAt`) — geen wachtwoord-, token-, of andere credential-kolom. `MatchSource.GMAIL` blijft ongewijzigd staan (nooit gebruikt, niet destructief verwijderd, per ADR-007's correctienotitie).

## 2. Generieke `EmailAdapter`-architectuur

```
src/integrations/email/
  types.ts               NormalizedEmailMessage, EmailMailboxAdapter-interface, stableEmailId()
  graph-client.ts         GraphCredential-abstractie, ClientSecretGraphCredential, graphGet()
  microsoft365-adapter.ts Microsoft365EmailAdapter (Graph-specifiek, uitsluitend hier)
  imap-adapter.ts          DisabledImapEmailAdapter (Phase 3C-B-placeholder)
  adapter.ts               ComposingEmailAdapter + createEmailAdapter() — het enige dat
                           Customer 360/Timeline daadwerkelijk importeren
```

Geen enkel provider-specifiek type (Graph-message-vorm, toekomstige IMAP-vorm) lekt buiten deze map — `NormalizedEmailMessage` (`types.ts`) is de enige vorm die de rest van de applicatie ziet.

`createEmailAdapter()` leest de actieve `MonitoredMailbox`-rijen uit de database, instantieert per rij de juiste sub-adapter, en bevraagt ze **parallel** via `Promise.allSettled` — één mailbox die faalt (verkeerde RBAC-scope, Graph-storing, ontbrekend credential) blokkeert nooit een andere. Dit is dezelfde `Promise.allSettled`-aanpak die de bestaande `TelefoonSysteemAdapter` al gebruikt over kandidaat-telefoonnummers, nu toegepast over mailboxen.

## 3. Microsoft365EmailAdapter

- `GET https://graph.microsoft.com/v1.0/users/{mailbox}/messages?$search="from:{addr} OR to:{addr} OR cc:{addr}"&$select=...&$top=25`
- Headers: `Authorization: Bearer {token}`, `ConsistencyLevel: eventual` (vereist bij `$search`), `Prefer: IdType="ImmutableId"` (stabiele message-ID's over foldermoves/forwards heen).
- `$select` beperkt de respons tot exact de benodigde velden: `id,conversationId,subject,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,bodyPreview,webLink` — geen bredere data-blootstelling dan nodig.
- **`$top=25`** — expliciete cap, geen paginering naar een volledige mailbox. Genoeg voor "recente e-mailhistorie per klant," niet bedoeld als volledige index.
- **Richting**: `from`-adres vergeleken (genormaliseerd) met de mailbox se eigen adres — gelijk → `OUTBOUND`, ongelijk → `INBOUND`. Betrouwbaar, geen gok (in tegenstelling tot TelefoonSysteem's `Call`-model, dat geen richtingssignaal heeft).
- **KQL-injectiebescherming**: een adres met een `"`-teken wordt geweigerd (query nooit verzonden) in plaats van ongeëscaped geïnterpoleerd — defense-in-depth, ook al maakt `normalizeEmail()`'s vormcontrole dit al zeldzaam.
- **Timeout + gecontroleerde retry**: 8s timeout per aanvraag; één retry bij een 5xx of netwerkfout, nooit bij 401/403/andere 4xx (die worden nooit met een retry opgelost). Nooit een rauwe Graph-foutmelding naar de aanroeper — altijd `[]` bij falen.

## 4. Graph-authenticatie

`src/integrations/email/graph-client.ts`:
- `GraphCredential`-interface (`acquireToken(): Promise<string>`) — `Microsoft365EmailAdapter` kent uitsluitend deze interface, nooit welk concreet credential-type actief is.
- `ClientSecretGraphCredential` (enige implementatie in Phase 3C-A) — wraps `@azure/msal-node`'s `ConfidentialClientApplication`, client-credentials-flow, scope `https://graph.microsoft.com/.default`. Tokencaching/-verversing wordt door MSAL zelf afgehandeld (officiële Microsoft-library) — deze code roept `acquireToken()` vóór elke aanvraag aan in plaats van zelf een tokenstring te bewaren.
- **Certificaat-uitbreidingspunt**: een toekomstige `CertificateGraphCredential`-klasse (nog niet gebouwd, geen certificaat beschikbaar) implementeert dezelfde `GraphCredential`-interface — toevoegen is een nieuwe klasse plus één branch in `createGraphCredential()`; niets in `microsoft365-adapter.ts`, de samenstellende `EmailAdapter`, of Customer 360 hoeft te wijzigen.
- Geen token ooit gelogd. Geen token ooit naar de browser (alle Graph-code draagt `import "server-only"`).

## 5. Customer matching

Ongewijzigd t.o.v. ADR-007, toegepast op e-mail-participanten via de al bestaande `resolveAndRecordByEmail()` (`src/modules/matching/matching.service.ts`, ongewijzigd):

- **Inbound**: afzender is de enige kandidaat.
- **Outbound**: elke ontvanger/cc (behalve de mailbox se eigen adres) is een kandidaat, gecapt op 10 per bericht (bescherming tegen een reply-all met tientallen ontvangers die één paginabezoek in tientallen schrijfacties zou veranderen).
- **`MatchSource.EMAIL`** — generiek, niet per provider (§6 van doc 30 voor de volledige onderbouwing van die keuze).
- Ambigue matches (hetzelfde adres bij meerdere `CustomerProfile`'s) worden als `AMBIGUOUS` opgeslagen, nooit automatisch definitief — bewezen via een echte, tegen de database draaiende testcase (zie §9).
- Deze matching-schrijfactie is een **neveneffect van het lezen** van e-mailhistorie (net als de bestaande Shopify-profielsnapshot die ook bij elk paginabezoek ververst), niet een `VIEWER`-geblokkeerde actie — de daadwerkelijke bevestiging/koppeling/ontkoppeling (`confirmMatch`/`manualLink`/`unlinkMatch`) blijft ongewijzigd achter `requireWriteAccess()`.

## 6. Customer 360 en Timeline

- **Overzicht**: nieuw, compact blok "Recente e-mails" (`RecentEmailsBlock.tsx`) naast het bestaande "Recente gesprekken"-blok — richting-icoon, onderwerp, andere partij, datum/tijd, korte `bodyPreview`, bronmailbox-label, `webLink`-icoon indien aanwezig. Geen volledige body ooit gerenderd; `bodyPreview`/onderwerp gaan als gewone React-tekst-interpolatie de pagina in, nooit via `dangerouslySetInnerHTML` — HTML-injectie via een berichtinhoud is daarmee structureel uitgesloten.
- **Activiteit**: `EMAIL_INBOUND`/`EMAIL_OUTBOUND` chronologisch tussen de bestaande event-types — de iconen/tints stonden al klaar in `ActivityTimelineView.tsx` sinds Phase 3a (voorbereid, nu voor het eerst daadwerkelijk gebruikt).
- **Stabiele, provider-aware Timeline-ID's**: `m365-{mailboxId}-{externalMessageId}` (en, sinds Phase 3C-B, `imap-{mailboxId}-{uidValidity}-{uid}`), gebouwd via de gedeelde `stableEmailId()`-helper (`types.ts`) — **uitsluitend** voor het Timeline-item-ID (ADR-008, interaction-scoped). **Correctie (na een architectuurreview vóór productie)**: deze paragraaf beschreef aanvankelijk dat dezelfde functie ook voor `ExternalContactMatch.externalRef` gebruikt werd — dat was zelf de architectuurfout (één matchrij per bericht in plaats van per klant-identiteit), inmiddels gecorrigeerd. `externalRef` is nu het genormaliseerde e-mailadres, nooit een bericht-ID — zie `docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md`.
- **0 nieuwe top-level tabs** — ongewijzigd t.o.v. het bestaande, al bevestigde uitgangspunt.
- `AdapterStatusBanner` uitgebreid met een e-mailregel — nu `async` (leest `MonitoredMailbox` uit de database), de andere drie adapterstatussen blijven synchroon/env-var-gedreven.

## 7. Huidige Microsoft 365 / RBAC-configuratiestatus

**Geen enkele Microsoft 365-configuratie bestaat momenteel** — geverifieerd:
- Lokaal: `MICROSOFT_GRAPH_TENANT_ID`/`_CLIENT_ID`/`_CLIENT_SECRET` niet gezet — `createEmailAdapter()` degradeert correct naar "niet beschikbaar" (geverifieerd, zie §9/§10).
- Staging (`stones4u-control-center-staging`): `fly secrets list` bevestigt **geen** `MICROSOFT_GRAPH_*`-secrets aanwezig (alleen de reeds bekende Shopify/R2/Phase 3b-secrets).

**Gestopt volgens instructie** — geen staging-deploy uitgevoerd, geen enkele bredere/vervangende toestemming gecreëerd om een test makkelijker te maken.

## 8. Exacte beheerhandelingen die nog van Fons nodig zijn

Vóór een staging-deploy van Phase 3C-A mogelijk is, moet een Microsoft 365-beheerder (Exchange Administrator-rol of gelijkwaardig) het volgende uitvoeren — **buiten dit repository, buiten wat code kan afdwingen**:

1. **Azure AD app-registratie** aanmaken voor Control Center (bijv. "Stones4U Control Center — E-mailintegratie"), met een `client_secret` (staging/local-geschikt — zie doc 30 §3.1 voor de latere certificaat-voorkeur).
2. **`Mail.Read` (Application) permission** toevoegen aan de app-registratie.
3. **Exchange Online RBAC for Applications** configureren (PowerShell, `Connect-ExchangeOnline` vereist):
   - `New-ServicePrincipal -AppId <azure-app-id> -ObjectId <sp-object-id> -DisplayName "..."`
   - Een resource-scope die uitsluitend `info@stones4u.nl` omvat (management scope of een mail-enabled security group met alleen dit adres).
   - `New-ManagementRoleAssignment -App <sp-object-id> -Role "Application Mail.Read" -CustomResourceScope "<scope>"`
4. **Kritiek, expliciet te controleren**: `Mail.Read` **niet** óók tenant-breed consenten via de Azure Portal/Entra admin center naast stap 3 — de vereniging van een ongescoopte Entra-grant en een gescoopte RBAC-grant resulteert in ongescoopte toegang (doc 30 §3.2, rechtstreeks uit Microsoft's eigen documentatie).
5. De drie waarden (`tenant_id`, `client_id`, `client_secret`) **niet aan mij doorgeven als tekst** — rechtstreeks als Fly-secrets zetten op `stones4u-control-center-staging` zodra de vorige stappen voltooid zijn, of aan mij aangeven "de drie staging-secrets staan klaar" zodat ik ze via `fly secrets set` kan laten instellen zonder de waarden ooit te zien getoond.

Geen van deze stappen is door mij uit te voeren — ze vereisen Microsoft 365-tenantbeheerdersrechten die buiten dit CRM-repo en buiten mijn toegang liggen.

## 9. Tests

178/178 groen (30 testbestanden, 5 nieuw/uitgebreid voor Phase 3C-A):

- `tests/graph-client.test.ts` (12) — credential-factory (env-var-aanwezigheid), MSAL-scope-aanroep, generieke fout bij ontbrekend token, `graphGet()`: succes, 401/403 zonder retry, 5xx met één retry (en herstel na retry), timeout zonder retry, credential-fout zonder fetch-aanroep.
- `tests/microsoft365-adapter.test.ts` (12) — INBOUND/OUTBOUND-richtingsbepaling (incl. hoofdletter-/spatie-ongevoelig), cc/meerdere ontvangers, ontbrekende preview/conversationId/webLink → `null`, bericht zonder geldige `from` overgeslagen, onparseerbare datum overgeslagen, dedup over meerdere bevraagde adressen, fail-safe bij netwerkfout, KQL-injectieweigering, correcte headers/`$top`-cap.
- `tests/imap-adapter.test.ts` (3) — altijd `available: false`, nooit een netwerkaanroep, provider/adres correct blootgesteld.
- `tests/timeline-email.test.ts` (5) — `EMAIL_INBOUND`/`EMAIL_OUTBOUND`-kind, titel voor inbound/outbound/meerdere ontvangers, samenvatting-fallback, provider-prefix-ID's botsen nooit.
- `tests/email-adapter.test.ts` (3, tegen een echte lokale database) — geen mailboxen → disabled; mailbox zonder credential → disabled met duidelijke reden; **end-to-end**: exacte inbound-match, ambigue outbound-match (hetzelfde adres bij twee `CustomerProfile`'s, beide `AMBIGUOUS`, geen van beide automatisch bevestigd), geen match voor een onbekende afzender, en een tweede, kapotte mailbox die de eerste, werkende mailbox niet blokkeert.
- `tests/matching.test.ts` (+1) — `MatchSource.EMAIL` wordt geaccepteerd door de bestaande matching-service.

**Tijdens het testen zelf gevonden en gefixte bug**: de matching-schrijfactie in `adapter.ts` gebruikte aanvankelijk `"microsoft365"` als ID-prefix, terwijl de Timeline-projectie in `timeline.ts` `"m365"` gebruikte — twee verschillende naamgevingen voor hetzelfde bericht. Opgelost door één gedeelde `stableEmailId()`-helper (`types.ts`) die beide plekken nu gebruiken — de eerder geplande `m365-{mailboxId}-{messageId}`-vorm is nu overal consistent.

`npm run test` / `npm run typecheck` / `npm run lint` / `npm run build`: alle vier groen. `@azure/msal-node` toegevoegd als productie-dependency (niet dev) — het is een runtime-afhankelijkheid van de Graph-authenticatie.

**Live smoke test (lokaal, geen echte Graph-data)**: dev-server gestart, ingelogd met een kortstondig, willekeurig wachtwoord op het bestaande lokale `viewer@stones4u.local`-testaccount (via een script, nooit getoond, direct na gebruik weer ongeldig gemaakt), Customer 360 voor de bestaande "Fons Verkoelen"-testklant bezocht: Overzicht-tab toont het "Recente e-mails"-blok met de correcte lege-status ("Geen recente e-mails" — verwacht, want geen `MonitoredMailbox`-rij en geen Graph-credentials lokaal), Activiteit-tab (met de nu-`async` `AdapterStatusBanner`) laadt zonder fout. Geen enkele echte Graph-aanroep (geen credentials aanwezig om er een te maken).

## 10. Security

- Alle Graph-/e-mailcode draagt `import "server-only"` — geen credential, token, of Graph-respons bereikt ooit de browser (geverifieerd, zelfde controle als bij Phase 3b).
- Geen rauwe Graph-foutmelding wordt ooit doorgegeven — elke fout degradeert naar een generieke, server-side gelogde melding en een lege resultatenlijst.
- Geen berichttekst/HTML-injectie: `bodyPreview` en `subject` zijn platte tekst (Graph levert geen HTML in deze velden), en worden via gewone React-tekst-interpolatie gerenderd — geen `dangerouslySetInnerHTML` ergens in `RecentEmailsBlock.tsx`.
- Mailboxscope wordt nergens in de code verbreed — `Microsoft365EmailAdapter` vraagt uitsluitend `Mail.Read`-achtige data op via de al gedefinieerde `$select`-lijst; het daadwerkelijke toegangsbereik wordt tenant-side afgedwongen (RBAC for Applications, buiten dit repo).
- Geen berichttekst lokaal opgeslagen (categorie B, ADR-008, ongewijzigd), geen bijlagen ooit opgehaald (geen enkele Graph-aanroep raakt `/attachments`).
- Response-caps: `$top=25` (Graph), `MAX_MATCH_PARTICIPANTS_PER_MESSAGE = 10` (matching-schrijfactie).
- Timeouts: 8s per Graph-aanvraag, met exact één gecontroleerde retry (nooit op 4xx).
- Auth guards: geen nieuwe CRM-API-route toegevoegd in Phase 3C-A (de e-mailadapter wordt server-side binnen de al door `getSessionUser()`/de bestaande `(app)`-layout beveiligde Customer-360-pagina aangeroepen — dezelfde beveiligingsgrens als telefonie/offertes). De enige geraakte route, `/api/customers/[id]/matches`, had al `requireUser()` (GET) / `requireWriteAccess()` (POST) — ongewijzigd, alleen de geaccepteerde `source`-waardenlijst uitgebreid met `"EMAIL"`.
- `VIEWER` kan matching niet wijzigen: ongewijzigd — `confirmMatch`/`manualLink`/`unlinkMatch` blijven achter `requireWriteAccess()`. De automatische matching-suggestie (§5) is geen "wijziging" in die zin — nooit `confirmedByUserId` gezet, nooit `AMBIGUOUS` stilzwijgend opgelost.
- Logs: uitsluitend generieke, statuscode-/foutklasse-berichten (`graph_http_error`, `graph_timeout`, `microsoft365_email_fetch_failed`, ...) — nooit een token, berichttekst, of credential.
- Audit op handmatige matching: ongewijzigd (`customer_match.confirmed`/`customer_match.unlinked`, bestaand mechanisme, niet aangeraakt).

**Beknopte dreigingsmodel-uitbreiding voor e-mail**:

| Dreiging | Mitigatie |
|---|---|
| App-credential gecompromitteerd → toegang tot te veel mailboxen | RBAC for Applications beperkt het bereik tenant-side tot exact `info@stones4u.nl`, ongeacht wat de applicatiepermissie op papier toestaat (mits de valkuil in §8 punt 4 vermeden wordt) |
| KQL-injectie via een gemanipuleerd klant-e-mailadres | `buildSearchQuery()` weigert elk adres met een `"`-teken |
| Berichtinhoud (HTML/script) getoond als opgeslagen XSS | Nooit `dangerouslySetInnerHTML`; alleen platte tekst (`bodyPreview`/`subject`) via React-tekst-interpolatie |
| Denial-of-service via een mailbox met duizenden berichten | `$top=25`-cap, 8s timeout, één gecontroleerde retry |
| Eén verkeerd geconfigureerde mailbox breekt de hele pagina | `Promise.allSettled` op mailboxniveau — ongewijzigd fail-safe-patroon |
| Matching-schrijfactie misbruikt als omweg om een klant te "claimen" | `resolveAndRecordByEmail()` maakt nooit een definitieve/bevestigde match aan zonder mens; `AMBIGUOUS` blijft zichtbaar-onzeker |
| Token/secret-lekkage in logs | Alleen generieke foutklassen gelogd, nooit de token/het antwoordlichaam |

## 11. Beperkingen

- **Microsoft 365-pad**: volledig gebouwd, niet live te testen zonder de in §8 genoemde beheerhandelingen.
- **IMAP-pad (`info@stones4u.eu`)**: uitsluitend interface/disabled-placeholder, exact zoals gevraagd — geen netwerkcode, geen bibliotheek toegevoegd. Blijft `available: false` totdat host/poort/TLS/auth bekend zijn (doc 30 §12).
- **`Mail.ReadBasic`/`Mail.ReadBasic.All`-scope-precisie**: nog steeds niet volledig herbevestigd tegen de actuele Graph-documentatie (ongewijzigd open punt uit de vorige documentatieronde) — verandert de aanbeveling niet (snippet/preview vereist sowieso `Mail.Read`).
- **Certificaatgebaseerde authenticatie**: uitbreidingspunt aanwezig (`GraphCredential`-interface), niet geïmplementeerd — geen certificaat beschikbaar.
- **Matching-schrijfvolume**: elke e-mail met klant-participanten schrijft (idempotent, upsert) een `ExternalContactMatch`-rij per paginabezoek waarbij nieuwe berichten gevonden worden — geen probleem bij Stones4U's verwachte volumes, maar een bewuste designkeuze om te documenteren, geen verborgen bijeffect.
- **Geen Command-Palette-uitbreiding voor e-mail** in Phase 3C-A — niet gevraagd in deze scope, consistent met doc 30/29's oorspronkelijke afbakening (e-mailinhoud wordt nooit globaal doorzoekbaar, alleen zichtbaar in Customer-360-context).

## 12. Volgende stap

Zodra Fons (of een aangewezen Microsoft 365-beheerder) de in §8 genoemde stappen heeft uitgevoerd en de drie staging-secrets rechtstreeks als Fly-secrets beschikbaar zijn: staging-deploy van uitsluitend `stones4u-control-center-staging`, seed van één `MonitoredMailbox`-rij (`info@stones4u.nl`, `MICROSOFT365`, `enabled: true`), en de in de oorspronkelijke opdracht beschreven E2E-staging-test (echte Graph-keten, mailbox-buiten-scope-weigering, geen secrets in logs/browser) — geen van deze stappen is in deze ronde uitgevoerd.
