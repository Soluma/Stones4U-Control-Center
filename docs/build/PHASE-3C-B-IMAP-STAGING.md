# Phase 3C-B — IMAP e-mailintegratie (info@stones4u.eu, Xel): build report

**Status (2026-09-03, bijgewerkt) — staging E2E geslaagd.** Code gebouwd en getest (225/225 tests groen, typecheck/lint/build groen), gedeployed naar `stones4u-control-center-staging`, migratie toegepast, `MonitoredMailbox` geseed. Na Fons' juiste `IMAP_PASSWORD`: een echte, live IMAP-verbinding met `mail.xel.nl` is gelukt — folder discovery, het read-only/unseen-bewijs, en een volledige echte-data-E2E-test (klant "JS Verkoelen", reëel Shopify-account, reële correspondentie) zijn allemaal geslaagd. Zie de eindrapportage in de chat voor de volledige resultaten per stap. Microsoft 365/`info@stones4u.nl` blijft geparkeerd. Niets gecommit, niets gepusht, geen productie-actie.

> **Correctie (2026-09-03, ná bovenstaande E2E) — architectuurfout gevonden en gecorrigeerd vóór productie.** De hierboven beschreven E2E-run maakte 25–26 `ExternalContactMatch`-rijen aan (één per e-mailbericht) in plaats van de door ADR-007 bedoelde één rij per externe contactidentiteit. Zie `docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md` voor de volledige analyse, de codefix (`src/integrations/email/adapter.ts`), de opschoning van de foutieve staging-legacydata, en de herhaalde E2E-validatie (nu: exact 1 rij per klant, canoniek e-mailadres als `externalRef`, geen groei bij herhaald paginabezoek). Dit document (hieronder, ongewijzigd) blijft correct voor alles behalve de matching-opslagvorm.

**Oorspronkelijke buildrapport hieronder, ongewijzigd** (beschrijft de code zoals gebouwd vóór de staging-E2E-ronde):

Vervolg op `docs/platform-discovery/30-PHASE-3C-EMAIL-INTEGRATION-DISCOVERY.md` (architectuur) en `docs/build/PHASE-3C-A-MICROSOFT365-STAGING.md` (Phase 3C-A-buildrapport). Dit document beschrijft uitsluitend wat voor het IMAP-pad daadwerkelijk gebouwd is.

## 1. IMAP-implementatie

`DisabledImapEmailAdapter` (Phase 3C-A-placeholder) is vervangen door een echte `ImapEmailAdapter` in `src/integrations/email/imap-adapter.ts` — de disabled variant blijft bestaan en wordt gebruikt zodra `IMAP_HOST`/`IMAP_PORT`/`IMAP_USERNAME`/`IMAP_PASSWORD` ontbreken, exact hetzelfde patroon als de al bestaande `Disabled*`-adapters.

```
src/integrations/email/
  imap-config.ts    createImapConfig() — env-var-gedreven, geen database
  imap-mime.ts       BODYSTRUCTURE-tekstdeel-zoeker + veilige preview-decodering
  imap-adapter.ts     ImapEmailAdapter (echt) + DisabledImapEmailAdapter (ongewijzigd)
```

`ImapEmailAdapter` implementeert dezelfde `EmailMailboxAdapter`-interface als `Microsoft365EmailAdapter` — geen enkele wijziging aan `types.ts`, de samenstellende `EmailAdapter` (`adapter.ts`), `Customer 360`, of de Timeline was nodig om deze provider daadwerkelijk te activeren. `adapter.ts` kiest nu per `MonitoredMailbox`-rij met `provider: "IMAP"` tussen de echte adapter (als `createImapConfig()` een config oplevert) en de disabled placeholder (anders).

## 2. Dependencies

- **`imapflow`** (v1.7.8) — het IMAP-protocol zelf: connect/list/search/fetch/logout. Gekozen zoals gevraagd; geen alternatief overwogen nodig, dit is de facto standaard, actief onderhouden, promise-based Node-IMAP-client.
- **`mailparser`** (v3.9.20, met `@types/mailparser`) — **uitsluitend** gebruikt om één, al vooraf via BODYSTRUCTURE geïdentificeerd en grootte-gecapt tekstdeel te decoderen (charset/`Content-Transfer-Encoding`/HTML-naar-tekst) — nooit voor de volledige, mogelijk bijlage-bevattende berichtstructuur. Hergebruikt mailparser's eigen, beproefde `libmime`/`html-to-text`-afhankelijkheden in plaats van deze logica handmatig te herbouwen.

Geverifieerd vóór gebruik, rechtstreeks in de geïnstalleerde broncode (niet alleen documentatie): ImapFlow's `fetch()`-commandobouwer (`lib/commands/fetch.js`) gebruikt **altijd** `BODY.PEEK[...]`, nooit kaal `BODY[...]` — het package se eigen commentaar: *"PEEK avoids marking messages as \Seen."* Dit is niet optioneel of instelbaar — het is hardcoded gedrag van de library voor elke inhoud-opvragende fetch (§4).

## 3. Configuratie / env vars

Exact zoals voorgesteld, plus de optionele Sent-override:

```
IMAP_HOST
IMAP_PORT
IMAP_SECURE       (default true als niet gezet; expliciet "false" nodig om uit te schakelen)
IMAP_USERNAME
IMAP_PASSWORD
IMAP_SENT_MAILBOX (optioneel — alleen als automatische \Sent-detectie niet lukt)
```

Eén mailbox, één credential-set — niet per `MonitoredMailbox`-rij (net als Microsoft 365's tenant-brede credential, zie doc 30 §0). `createImapConfig()` (`imap-config.ts`) is puur env-var-gedreven, geen database-toegang. Geen enkele credential ooit in PostgreSQL, nooit gelogd, nooit naar de browser (`import "server-only"` in elk bestand).

## 4. Folder discovery

`resolveSentMailbox()` in `imap-adapter.ts`:
1. `IMAP_SENT_MAILBOX` override, indien gezet — altijd voorrang.
2. Anders: `client.list()`, zoek een map met `specialUse === "\\Sent"` **én** `specialUseSource === "extension"` (d.w.z. server-bevestigd via de SPECIAL-USE/XLIST-extensie — geverifieerd tegen ImapFlow's eigen typedefinities, die expliciet drie bronnen onderscheiden: `"extension"`, `"name"` (ImapFlow's eigen naam-heuristiek) en `"user"`).
3. **Een `specialUseSource: "name"`-resultaat (ImapFlow's eigen gok op basis van bekende foldernamen) wordt NIET vertrouwd** — expliciet, precies zoals gevraagd ("kies geen willekeurige map"). Als geen server-bevestigde `\Sent`-map gevonden wordt, wordt de volledige mapinventaris gelogd (server-side, geen berichtinhoud) voor diagnose, en wordt Sent als niet-beschikbaar behandeld — uitgaande e-mail wordt dan simpelweg niet gevonden totdat `IMAP_SENT_MAILBOX` expliciet gezet wordt.

**Welke Sent-map Xel daadwerkelijk gebruikt voor `info@stones4u.eu` is nog niet bekend** — dit vereist een echte verbinding, die pas gemaakt kan worden zodra Fons het wachtwoord zelf heeft ingevoerd (§7). Zodra dat gebeurt, is dit het eerste te rapporteren feit uit de E2E-staging-test.

## 5. Read-only garanties

- **Elke inhoud-opvragende IMAP-aanroep gebruikt `BODY.PEEK`**, geverifieerd in de daadwerkelijke ImapFlow-broncode (§2) — geen enkele aanroep in dit project zet ooit de `\Seen`-vlag.
- **Geen enkele schrijfoperatie ergens in de code**: `imap-adapter.ts` roept uitsluitend `connect`, `list`, `getMailboxLock`, `search`, `fetch`, `fetchOne`, `logout` aan — nooit `messageFlagsAdd`/`messageFlagsRemove`/`messageDelete`/`messageCopy`/`messageMove`/`append`/`mailboxCreate` of enige andere schrijf-vormende ImapFlow-methode. Een test controleert expliciet dat geen van deze methoden ooit op de (nagebootste) client wordt aangeroepen.
- **Query-input**: server-side `SEARCH FROM/TO/CC` wordt uitsluitend gebruikt om **kandidaten** op te halen — elke kandidaat wordt daarna **altijd** lokaal, exact, genormaliseerd gevalideerd (`normalizeEmail()`) vóórdat hij als echte match behandeld wordt. Dit vangt IMAP's bekende substring-/providerafhankelijke zoekgedrag af — een server die "bredere" resultaten teruggeeft dan een exacte match, wordt hier altijd teruggebracht tot exact.
- **TLS-certificaatverificatie**: nooit uitgeschakeld — `tls.rejectUnauthorized` wordt nergens in de code gezet (Node's eigen, standaard-aan-gedrag blijft ongewijzigd van kracht). Expliciet gedocumenteerd in `imap-adapter.ts` als bewuste beslissing, niet een omissie.

## 6. Query-/matchingstrategie

- **Inbound**: `SEARCH FROM {adres}` in `INBOX`.
- **Outbound**: `SEARCH (OR TO {adres} CC {adres})` in de ontdekte/geconfigureerde Sent-map.
- IMAP-UID's zijn oplopend toegekend — de nieuwste berichten hebben de hoogste UID's. In plaats van alle kandidaat-UID's se envelopes op te halen (mogelijk honderden voor een langlopende klantrelatie) en pas daarna te sorteren/knippen, wordt eerst `.slice(-25)` op de ruwe UID-lijst toegepast — nooit de hele mailbox opgehaald.
- Na de eind-sortering (nieuwste eerst, over inbound+outbound gecombineerd) wordt nogmaals op **25** resultaten per mailbox gecapt.
- Matching: hergebruikt de al bestaande, ongewijzigde `resolveAndRecordByEmail()` (ADR-007/`MatchSource.EMAIL`, dezelfde functie als Microsoft 365 al gebruikt) — nooit fuzzy op naam/onderwerp, ambigue adressen (hetzelfde adres bij meerdere `CustomerProfile`'s) worden `AMBIGUOUS`, nooit automatisch definitief.

## 7. Message parsing / preview

- `findInlineTextPart()` (`imap-mime.ts`) doorloopt de BODYSTRUCTURE, kiest het eerste `text/plain`-deel; valt terug op `text/html` alleen als er nergens een `text/plain`-deel bestaat; sluit expliciet elk deel met `Content-Disposition: attachment` uit (een bijgevoegd `.txt`/`.html`-bestand is niet de berichttekst).
- Alleen **dat ene deel** wordt opgehaald, gecapt op **8192 bytes** ruwe (nog gecodeerde) inhoud — nooit de volledige body, nooit een bijlage.
- Decodering (charset, `quoted-printable`/`base64`, HTML-naar-tekst) via een minimale, synthetische enkel-deel-boodschap die aan `mailparser` wordt gevoed — mailparser ziet nooit de originele, mogelijk bijlage-bevattende structuur. `.text` (mailparser's eigen veilige tekstvorm, ook afgeleid van HTML indien nodig) wordt gebruikt; `.html`/`.attachments` worden nergens gelezen.
- Preview: witruimte samengevoegd, gecapt op **300 tekens** met een `…`-marker bij afkapping.
- **Nooit** een crash bij een kapot/afgekapt deel — elke decodeerstap zit in een `try/catch`, degradeert naar `null`.

## 8. Multipart / bijlagen

- Multipart-berichten worden voldoende ondersteund om het tekstdeel te vinden (recursieve BODYSTRUCTURE-doorloop), maar **geen enkele bijlage wordt ooit opgehaald of geparsed** — de code vraagt uitsluitend het specifieke, vooraf geïdentificeerde tekstdeel op via `bodyParts: [{key, maxLength}]`, nooit een breder deel of de volledige bron.
- Resource-caps, expliciet vastgelegd: `MAX_RESULTS_PER_MAILBOX = 25`, `BODY_PART_FETCH_CAP_BYTES = 8192`, `PREVIEW_MAX_LENGTH = 300` (in `imap-mime.ts`), envelope-only voor headers (geen ongebonden `headers: true`-fetch ergens).
- Timeouts: `connectionTimeout`/`greetingTimeout` = 8s, `socketTimeout` = 15s (ImapFlow-eigen, protocol-bewuste timeout-mechanismen — geverifieerd als de correcte optienamen in de geïnstalleerde typedefinities).
- Eén corrupt bericht (ontbrekende envelope, onparseerbare datum, kapotte structuur) faalt geïsoleerd (`try/catch` per bericht) — de rest van de mailbox-query gaat gewoon door.

## 9. Stabiele identiteit

`externalMessageId` voor een IMAP-bericht is `"{uidValidity}-{uid}"` (bijv. `"987654321-15"`) — UID alleen is bewust niet genoeg (een UIDVALIDITY-reset zou anders tot een botsing kunnen leiden). Dit is samengesteld zodat de **al bestaande, ongewijzigde** `stableEmailId()`-helper (`types.ts`, ook gebruikt door de Timeline-projectie en de matching-`externalRef` — zie het Phase 3C-A-buildrapport voor de bug die dit deelgebruik voorkwam) automatisch de gevraagde vorm produceert: `imap-{mailboxId}-{uidValidity}-{uid}` — zonder die gedeelde helper zelf te wijzigen.

## 10. EmailAdapter-aggregatie

`createEmailAdapter()` (`adapter.ts`) instantieert de Graph-credential en de IMAP-config **volledig onafhankelijk van elkaar** — een ontbrekende/foutieve Microsoft 365-configuratie beïnvloedt de IMAP-tak op geen enkele manier, en omgekeerd. Bewezen met een echte, tegen de database draaiende testcase: Microsoft 365 onbeschikbaar (geen Graph-credential) + IMAP beschikbaar → `EmailAdapter.status()` is `available: true` en levert uitsluitend de IMAP-resultaten; en apart, IMAP onbeschikbaar zonder een Microsoft 365-rij → nette, niet-crashende degradatie.

## 11. Customer 360

Ongewijzigd — het al gebouwde "Recente e-mails"-blok (Overzicht) en de Activiteit-tab tonen IMAP-berichten identiek aan Microsoft 365-berichten (provider-onafhankelijk, `NormalizedEmailMessage` is de enige vorm die de UI ziet). `webLink` is voor IMAP altijd `null` (geen bekend veilig Xel-webmail-linkpatroon) — `RecentEmailsBlock.tsx` toont dan simpelweg geen "Openen"-icoon, geen kapotte link (was al zo gebouwd in Phase 3C-A, hier hergebruikt zonder wijziging).

## 12. Timeline

`EMAIL_INBOUND`/`EMAIL_OUTBOUND` blijven categorie B (nooit als `Activity` opgeslagen) — ongewijzigd. Chronologie/dedup/bronlabel: zelfde, al geteste code als Phase 3C-A (`timeline.ts` is in deze ronde niet gewijzigd — de bestaande `stableEmailId()`-integratie volstond).

## 13. Security review

- `import "server-only"` in elk nieuw bestand.
- Geen credential ooit client-side, nooit gelogd (alleen generieke foutklassen: `imap_connect_failed`, `imap_auth_failed`, `imap_sent_mailbox_not_confirmed`, ...), nooit in PostgreSQL.
- TLS-verificatie nooit uitgeschakeld (§5) — expliciet getest/gedocumenteerd, geen `rejectUnauthorized: false` ergens in de code.
- Geen enkele write-IMAP-aanroep — geverifieerd via een test die controleert dat de (nagebootste) client geen schrijfmethoden ooit aanroept.
- Geen mark-as-seen — gegarandeerd door ImapFlow's eigen `BODY.PEEK`-gedrag (§2), niet iets dat deze code zelf hoeft af te dwingen maar wel expliciet geverifieerd tegen de broncode.
- Geen rauwe HTML-render — `bodyPreview` is altijd platte tekst (mailparser's `.text`, nooit `.html`), gerenderd via gewone React-tekst-interpolatie in `RecentEmailsBlock.tsx` (ongewijzigd sinds Phase 3C-A), nooit `dangerouslySetInnerHTML`.
- Query-input veilig: server-side SEARCH-kandidaten worden altijd lokaal exact hervalideerd (§6); geen KQL-equivalent injectierisico bij IMAP SEARCH-parameters zoals bij Graph's `$search` (ImapFlow bouwt de IMAP-commandostructuur zelf op basis van gestructureerde `SearchObject`-velden, niet een los samengestelde querystring).
- Response-caps + timeouts: §8.
- Geen berichttekst in auditlogs — de matching-schrijfactie (`resolveAndRecordByEmail`) logt alleen `source`/`customerProfileId`/`externalRef` (bestaand, ongewijzigd mechanisme), nooit `bodyPreview`/`subject`.

## 14. Tests / typecheck / lint / build

225/225 tests groen (32 bestanden, 5 nieuw/uitgebreid voor Phase 3C-B t.o.v. de 178/30 van Phase 3C-A):

- `tests/imap-config.test.ts` (7) — env-var-vereisten, `IMAP_SECURE`-default/override, ongeldige poort, optionele Sent-override.
- `tests/imap-mime.test.ts` (13) — tekstdeel-zoeken (plain-voorkeur, html-fallback, attachment-uitsluiting, geen-tekst-deel, geneste multipart/mixed+alternative), preview-decodering (plain, quoted-printable, veilige HTML-naar-tekst-reductie zonder markup, afkapping, lege/kapotte input nooit een crash).
- `tests/imap-adapter.test.ts` (31, inclusief de behouden `DisabledImapEmailAdapter`-tests) — een volledig nagebootste ImapFlow-client: read-only-garantie (geen schrijfmethode ooit aangeroepen), foldervondst (server-bevestigd/override/nooit-een-gok), inbound/outbound-matching (incl. het expliciete substring-zoek-terugval-scenario en genormaliseerde vergelijking), stabiele identiteit (UIDVALIDITY+UID, geen botsing na een hypothetische reset), parsing (preview, geen-tekst-deel, ontbrekend onderwerp, kapot bericht overgeslagen zonder de hele query te laten falen, onparseerbare datum), fail-safe (auth-fout, connectiefout, mailbox-lock-fout, lege mailbox, `search()` → `false`, `logout()` altijd aangeroepen ook na een fout).
- `tests/email-adapter.test.ts` (+2, tegen een echte lokale database) — Microsoft 365 onbeschikbaar + IMAP beschikbaar levert gewoon de IMAP-resultaten (incl. een echte `ExternalContactMatch`-rij met het correcte `imap-{mailboxId}-{uidValidity}-{uid}`-`externalRef`); IMAP onbeschikbaar degradeert netjes.

`npm run test`/`typecheck`/`lint`/`build`: alle vier groen. **Tijdens het bouwen zelf gevonden en verholpen omgevingsprobleem** (geen code-bug): een eerdere `npm run dev`-achtergrondsessie was door een falende `kill %1` (bash-jobcontrol werkt onbetrouwbaar over de Windows/git-bash-grens heen) niet volledig beëindigd en hield `.next/trace` vergrendeld, wat een volgende `npm run build` liet hangen — opgelost door de exacte, geïdentificeerde achtergebleven Node-processen (via `Get-CimInstance`/`Stop-Process`) te beëindigen en `.next` opnieuw op te bouwen; geen van deze processen was gerelateerd aan de daadwerkelijke code.

**Live lokale smoke test** (geen echte Xel-data): dev-server gestart, ingelogd met een kortstondig, willekeurig wachtwoord op het bestaande `viewer@stones4u.local`-testaccount (nooit getoond, direct na gebruik ongeldig gemaakt), een tijdelijke `MonitoredMailbox`-rij (`info@stones4u.eu`, `IMAP`, `enabled: true`, **geen echte credentials**) lokaal geseed, Customer 360 voor "Fons Verkoelen" bezocht: Overzicht toont "Recente e-mails" met de correcte lege status, Activiteit-tab toont de correcte "E-mailgeschiedenis is nog niet gekoppeld"-melding (bewijst dat `DisabledImapEmailAdapter`'s reden-string via `AdapterStatusBanner` correct doorkomt), geen crash. De tijdelijke rij en het testwachtwoord zijn direct daarna weer verwijderd/ongeldig gemaakt.

## 15. Handmatige credentialstap — nu bij Fons

**Ik heb geen enkel echt Xel-wachtwoord gezien, gevraagd, of ontvangen** — conform de expliciete instructie. Zodra Fons het wachtwoord veilig zelf heeft ingevoerd (nooit in de chat, nooit aan Claude, nooit in een bestand, nooit in git), zijn dit de exacte Fly-secrets die op **`stones4u-control-center-staging`** gezet moeten worden (niet productie):

```
IMAP_HOST=mail.xel.nl
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USERNAME=<mailbox-login van info@stones4u.eu>
IMAP_PASSWORD=<mailbox-wachtwoord>
```

En, alleen indien de E2E-test in §4 aantoont dat automatische Sent-detectie niet lukt voor deze specifieke Xel-mailbox:

```
IMAP_SENT_MAILBOX=<geverifieerde mapnaam>
```

Ik kan deze zes secrets voor u zetten via `fly secrets set` **zonder de waarden ooit te tonen**, zodra u bevestigt dat het wachtwoord (en eventueel de exacte mailbox-login, als die afwijkt van het volledige e-mailadres) veilig bij u klaarstaat — ik hoef de waarde zelf niet te zien om het commando uit te voeren.

## 16. Bekende beperkingen

- **Sent-mapnaam bij Xel**: nog onbekend — pas te bevestigen bij de eerste echte verbinding (§4).
- **`webLink`**: altijd `null` voor IMAP — geen bekend veilig Xel-webmail-deep-link-patroon; kan een latere, aparte toevoeging zijn zodra bevestigd dat Xel zoiets aanbiedt.
- **`conversationId`**: altijd `null` voor IMAP — geen IMAP-native equivalent van Graph's `conversationId`; `References`/`In-Reply-To`-gebaseerde threading is bewust niet gebouwd (buiten scope, nooit verzonnen).
- **Preview-afkapping bij een encoded byte-cap**: het 8192-byte-plafond op het ruwe tekstdeel kan in zeldzame gevallen een quoted-printable-envelop midden in een `=XX`-reeks afkappen — kosmetisch (nooit een crash, mailparser/decodeBodyPartPreview degraderen veilig), geaccepteerd voor een korte preview, niet technisch opgelost.
- **Één credential-set voor de hele mailbox**: zoals gevraagd — geen per-`MonitoredMailbox`-credentialopslag; een tweede IMAP-mailbox met andere inloggegevens zou een apart env-var-schema vereisen (niet nu nodig, niet gebouwd).
- **Geen echte Xel-verbinding getest** — alles hierboven is geverifieerd tegen een nagebootste IMAP-server (unit-/integratietests) en tegen ImapFlow's eigen, geïnstalleerde broncode voor de kritieke BODY.PEEK-garantie — nooit tegen de daadwerkelijke `mail.xel.nl`.

## 17. Volgende stap

Zodra Fons bevestigt dat het Xel-wachtwoord veilig klaarstaat: de zes secrets in §15 op `stones4u-control-center-staging` zetten (nooit productie), de al bestaande Phase 3C-migratie via de normale release-flow toepassen, een `MonitoredMailbox`-rij voor `info@stones4u.eu`/`IMAP`/`enabled: true` seeden (Microsoft 365-mailbox niet toevoegen), en de in de oorspronkelijke opdracht beschreven E2E-staging-test uitvoeren (echte Xel-keten, Sent-map-bevestiging, geen mails gewijzigd, geen secrets in logs/browser) — geen van deze stappen is in deze ronde uitgevoerd.
