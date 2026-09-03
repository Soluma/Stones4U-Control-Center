# 30 — Phase 3C E-mailintegratie: Microsoft 365 + IMAP (provider-onafhankelijk)

**Vervangt**: `30-PHASE-3C-OUTLOOK-DISCOVERY.md` (verwijderd — die versie was nog Microsoft-specifiek in de centrale CRM-laag, wat een tweede, onjuiste aanname bleek: Stones4U heeft **twee** mailboxen op **twee verschillende providers**, niet één Microsoft 365-mailbox). Deze versie is definitief provider-onafhankelijk in de CRM-kernlaag. Correctie/uitbreiding van `27-PHASE-3-DISCOVERY.md` §2, `28-PHASE-3-ARCHITECTURE.md`, `29-PHASE-3-BUILD-SPEC.md` §Phase 3c, ADR-007, ADR-008.

Read-only discovery/architectuur — **geen implementatie, geen migratie, geen code, geen env secrets, geen deploy** in dit document.

> **Status (2026-09-03) — Phase 3C-A daadwerkelijk gebouwd**: het Microsoft 365-pad (§3) is geïmplementeerd en getest, maar **geparkeerd** vanaf Phase 3C-B (geen Entra/RBAC-werk, niet geconfigureerd, niet gedeployed) — zie `docs/build/PHASE-3C-A-MICROSOFT365-STAGING.md`.
>
> **Status (2026-09-03) — Phase 3C-B daadwerkelijk gebouwd én staging-gevalideerd met echte Xel-data.** Het IMAP-pad (§4, `info@stones4u.eu` via Xel) is geïmplementeerd, getest, gedeployed en met een echte IMAP-verbinding gevalideerd (`docs/build/PHASE-3C-B-IMAP-STAGING.md`). §6 ("Matching") hieronder is verscherpt na een architectuurreview vóór productie: `ExternalContactMatch.externalRef` moet de contactidentiteit zijn (genormaliseerd e-mailadres), nooit een bericht-ID — een fout die in de eerste implementatie sloop en vóór productie gecorrigeerd is, zie `docs/build/PHASE-3C-B-EMAIL-MATCH-FIX.md` voor de volledige analyse/fix/hertest. Microsoft 365 blijft geparkeerd. De rest van dit document (ontwerp/redenering) blijft ongewijzigd van toepassing.

## 0. Uitgangspunt: twee mailboxen, twee providers

| Mailbox | Provider | Integratie | Status |
|---|---|---|---|
| `info@stones4u.nl` | Microsoft 365 / Exchange Online | Microsoft Graph, application permissions | Ontwerp compleet (§3) |
| `info@stones4u.eu` | **Geen** Microsoft 365 | IMAP (waarschijnlijk) | Host/poort/TLS/auth nog onbekend — adapter ontworpen, niet configureerbaar (§4, §12) |

**Kernbeslissing**: de centrale CRM-laag (Customer 360, Activity Timeline, customer matching, fail-safe-gedrag) kent **geen enkel** Microsoft- of IMAP-specifiek detail. Alles wat provider-specifiek is, blijft achter een `EmailAdapter`-interface — exact hetzelfde architecturale principe dat dit platform al sinds Phase 1 toepast op Shopify/TelefoonSysteem/offerte-apps (`Disabled*Adapter`-patroon, nooit provider-details laten lekken buiten `src/integrations/*`).

## 1. Architectuur — `EmailAdapter` met twee providerimplementaties

```
src/integrations/email/
  adapter.ts              (nieuw — de samenstellende EmailAdapter die Customer 360/Timeline
                           daadwerkelijk aanroept; kent zelf geen provider-details)
  microsoft365-adapter.ts (nieuw — Microsoft365EmailAdapter, Graph-specifiek, uitsluitend hier)
  imap-adapter.ts         (nieuw — ImapEmailAdapter, IMAP-specifiek, uitsluitend hier)
  types.ts                (nieuw — NormalizedEmailMessage en gedeelde types, zie §2)
```

**Per-mailbox sub-adapter-interface** (intern, niet gezien door Customer 360/Timeline):

```ts
interface EmailMailboxAdapter {
  readonly mailbox: { id: string; emailAddress: string; provider: "MICROSOFT365" | "IMAP" };
  status(): { available: true } | { available: false; reason: string };
  // addresses = de al-bekende, genormaliseerde e-mailadressen van één klant
  // (zelfde aanroepvorm als de bestaande TelephonyAdapter.getCallsForPhoneNumbers /
  // QuotesAdapter.getQuotesForCustomer — geen nieuw patroon).
  searchMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]>;
}
```

`Microsoft365EmailAdapter` en `ImapEmailAdapter` implementeren beide exact deze interface — elk met zijn eigen, volledig ingekapselde protocol-/authenticatielogica (§3/§4). Geen van beide typen lekt buiten `src/integrations/email/`.

**Samenstellende laag** (dit is wat `getCustomerTimeline()`/Customer 360 daadwerkelijk aanroept):

```ts
export interface EmailAdapter {
  status(): { available: true } | { available: false; reason: string } | { available: "partial"; unavailableMailboxes: string[] };
  getMessagesForAddresses(addresses: string[]): Promise<NormalizedEmailMessage[]>;
}
```

`createEmailAdapter()` leest de actieve `MonitoredMailbox`-rijen (§5), instantieert per rij de juiste sub-adapter (`provider === "MICROSOFT365"` → `Microsoft365EmailAdapter`, `provider === "IMAP"` → `ImapEmailAdapter`), en roept ze **parallel, onafhankelijk** aan via `Promise.allSettled` — exact hetzelfde idioom als de al bestaande `TelefoonSysteemAdapter.getActivityForPhoneNumbers()` (`src/integrations/telephony/adapter.ts`), nu toegepast over mailboxen/providers in plaats van kandidaat-telefoonnummers. Een `rejected`-uitkomst voor mailbox A beïnvloedt de `fulfilled`-uitkomst voor mailbox B op geen enkele manier — dit is het mechanisme achter §10's fail-safe-eis.

**Waarom dit géén overbouw is**: dit voegt geen nieuw patroon toe — het is de vierde toepassing van het adapter-interface-principe dat al voor telefonie/quotes/Exact bestaat, nu met een extra laag (meerdere providers binnen één logische bron) omdat e-mail, in tegenstelling tot telefonie/offertes, vanaf dag één twee onafhankelijke leveranciers heeft.

## 2. Genormaliseerd e-mailmodel

Eén vorm, ongeacht provider — dit is wat Customer 360/Timeline/matching daadwerkelijk zien:

```ts
type EmailDirection = "INBOUND" | "OUTBOUND";

interface NormalizedEmailParticipant {
  address: string;        // altijd genormaliseerd via normalizeEmail() vóór hier
  name: string | null;
}

interface NormalizedEmailMessage {
  provider: "MICROSOFT365" | "IMAP";
  mailboxId: string;                 // MonitoredMailbox.id — CRM-intern, nooit een provider-ID
  mailboxAddress: string;            // info@stones4u.nl of info@stones4u.eu — voor Customer-360-weergave
  externalMessageId: string;         // provider-native ID (Graph message-id, of IMAP UID)
  conversationId: string | null;     // Graph conversationId, of een IMAP-afgeleide thread-sleutel indien
                                      // betrouwbaar afleidbaar — anders null, nooit verzonnen
  subject: string | null;
  from: NormalizedEmailParticipant;
  to: NormalizedEmailParticipant[];
  cc: NormalizedEmailParticipant[];
  occurredAt: Date;                  // sent/received-tijdstip, protocol-afhankelijk welke van de twee
  direction: EmailDirection;
  bodyPreview: string | null;
  webLink: string | null;            // alleen gezet wanneer de provider dit veilig, kant-en-klaar levert
}
```

Geen enkel veld in dit model is provider-specifiek van vorm — `provider`/`mailboxId`/`mailboxAddress` zijn juist de bewuste, expliciete "welke bron was dit"-velden, precies zodat Customer 360 dit kan tonen (§9) zonder dat de rest van de code ooit een `if (provider === "MICROSOFT365")`-vertakking nodig heeft buiten de renderlaag.

**Geen berichttekst, geen bijlagen** — `bodyPreview` is een korte snippet (analoog aan het eerdere Gmail-ontwerp se snippet-idee), nooit de volledige body. Ongewijzigd t.o.v. ADR-008: nooit lokaal opgeslagen, live per paginabezoek opgehaald.

## 3. Microsoft 365-pad — `info@stones4u.nl`

Ongewijzigd basisontwerp t.o.v. de vorige documentversie (application permissions, client-credentials — zie de oorspronkelijke onderbouwing), met twee precisiecorrecties na verder onderzoek:

### 3.1 Authenticatie — app-only / client-credentials, voorkeur certificaat

Eén Azure AD app-registratie voor Control Center, geauthenticeerd via de OAuth2 client-credentials-flow (zelfde patroon als de bestaande Shopify-integratie, ADR-006) — geen ingelogde gebruiker, geen per-mailbox OAuth-consent.

**Credential-vorm**: voor productie heeft een **certificaat** de voorkeur boven een `client_secret`-string — Microsoft's eigen aanbeveling voor langer-levende productie-apps (een client-secret is een platte, kopieerbare string met een vaste vervaldatum die handmatig beheerd moet worden; een certificaat ondertekent een JWT-assertion en is lastiger te exfiltreren/hergebruiken). Voor een eerste implementatie is een `client_secret` acceptabel als startpunt (eenvoudiger op te zetten, zelfde beveiligingsniveau als elk ander Fly-secret in dit project) — certificaatgebaseerde authenticatie is een niet-blokkerende, latere verharding (zie open beslissing §14.3).

### 3.2 Autorisatie/scoping — Exchange Online RBAC for Applications (geverifieerd tegen actuele Microsoft-documentatie)

Zonder verdere maatregelen geeft de `Mail.Read`-application-permission letterlijk toegang tot **elke** mailbox in het tenant ("read email in all mailboxes without a signed-in user," Microsoft's eigen omschrijving) — te breed voor dit doel. Microsoft's **huidige, aanbevolen** oplossing hiervoor is **RBAC for Applications** (Exchange Online) — dit is de opvolger van, en vervangt, het eerder in dit project genoemde "Application Access Policy"-mechanisme (bevestigd: *"This feature extends the current RBAC model in Exchange Online and it replaces Application Access Policies"*).

**Werking** (Exchange Online PowerShell, door een tenant-beheerder, buiten dit CRM-repo uit te voeren):

1. `New-ServicePrincipal -AppId <azure-app-id> -ObjectId <sp-object-id> -DisplayName "Stones4U Control Center"` — een Exchange-zijdige pointer naar de al bestaande Azure AD-app-registratie (geen nieuwe identiteit, alleen een koppeling).
2. Een resource-scope die precies `info@stones4u.nl` omvat — via een `New-ManagementScope` met een recipient-filter (bijv. op een mail-enabled security group met uitsluitend dit adres) of, voor een enkele mailbox, een vergelijkbare gerichte scope.
3. `New-ManagementRoleAssignment -App <sp-object-id> -Role "Application Mail.Read" -CustomResourceScope "<scope-naam>"` — koppelt de rol **en** de scope in één toewijzing.

**Kritieke valkuil, expliciet te vermijden**: RBAC for Applications-scoping werkt **naast**, niet in plaats van, een eventuele tenant-brede `Mail.Read`-consent in Microsoft Entra ID (de gangbare "API permissions" admin-consent-stap in de Azure Portal) — als **beide** actief zijn, is het resultaat de **vereniging** van beide (Microsoft's eigen voorbeeld bevestigt dit expliciet: een ongescoopte Entra-grant "unie" een gescoopte RBAC-grant tot **overal** toegang, niet tot de kleinere scope). **Concreet betekent dit**: bij het instellen van dit ontwerp mag `Mail.Read` (Application) **niet** ook tenant-breed geconsenteerd worden in de Azure Portal/Entra admin center — de autorisatie moet uitsluitend via de Exchange Online RBAC-roltoewijzing lopen. Dit is een scherpe, makkelijk te missen configuratiefout — expliciet op te nemen in de daadwerkelijke build-instructies (§13), niet iets dit document kan afdwingen vanuit de code zelf.

**Alternatief, als fallback genoemd**: het oudere Application Access Policy-mechanisme (`New-ApplicationAccessPolicy`) blijft technisch werken en is eenvoudiger te begrijpen voor een beheerder die er nog niet eerder mee gewerkt heeft, maar is door Microsoft expliciet als "vervangen" gemarkeerd — RBAC for Applications is de aanbevolen keuze voor een nieuwe implementatie (§14.5 vermeldt dit als een lichte, niet-blokkerende beheerderskeuze).

### 3.3 Permission — `Mail.Read` (Application), ongewijzigd

Zoals eerder vastgesteld en opnieuw bevestigd tegen Microsoft's actuele documentatie (inclusief de RBAC-for-Applications-rollenlijst, die exact dezelfde scheiding toont): `Application Mail.Read` is de minimale rol/permissie die `bodyPreview` (het gevraagde snippet/preview-veld) teruggeeft — `Application Mail.ReadBasic` sluit `body`, `previewBody`, attachments en extended properties expliciet uit, dus onvoldoende voor de gestelde eis. Geen `Mail.ReadWrite`, geen `Mail.Send`, geen `Calendars.*`/`Contacts.*`.

### 3.4 Zoeken, threading, origineel openen

Ongewijzigd t.o.v. de vorige versie: `GET /users/info@stones4u.nl/messages?$search="from:{addr} OR to:{addr}"` met `ConsistencyLevel: eventual`, `conversationId` voor threading, `webLink` voor "origineel openen." Zie voor de volledige veldenlijst §2 (generiek) — Graph levert alle genoemde velden direct.

### 3.5 Richting (INBOUND/OUTBOUND) — betrouwbaar afleidbaar

In tegenstelling tot TelefoonSysteem's `Call`-model (waar richting fundamenteel niet uit het schema is af te leiden, zie `27` §1.1) is e-mailrichting via Graph wél betrouwbaar te bepalen: `/users/{mailbox}/messages` op een specifieke mailbox bevat zowel ontvangen als verzonden berichten (Verzonden Items inbegrepen); vergelijk `from.emailAddress.address` (genormaliseerd) met de mailbox se eigen adres — gelijk → `OUTBOUND`, ongelijk → `INBOUND`. Geen aanname, geen heuristiek — een directe, betrouwbare vergelijking.

## 4. IMAP-pad — `info@stones4u.eu`

**Ontwerp, geen configuratie** — exact per de instructie. Geen host/poort/TLS/auth-methode wordt hier vastgesteld; die zijn nog onbekend (§12).

### 4.1 Architectuur

`ImapEmailAdapter` implementeert dezelfde `EmailMailboxAdapter`-interface (§1) via een generieke connectieconfiguratie:

```ts
interface ImapConnectionConfig {
  host: string;
  port: number;
  secure: boolean;              // implicit TLS (typisch poort 993) vs. STARTTLS
  auth:
    | { method: "PASSWORD"; username: string }      // credential zelf: uitsluitend server-side secret, nooit in dit object gelogd
    | { method: "OAUTH2"; username: string };        // credential: OAuth-token, indien de provider dit ondersteunt
}
```

Deze vorm is bewust generiek gehouden — zodra de daadwerkelijke waarden voor `info@stones4u.eu` bekend zijn (§12), wordt dit object gevuld vanuit server-side config/secrets, zonder dat de adapter-interface zelf hoeft te wijzigen.

**Bibliotheekkeuze** (indicatief, niet aan te schaffen/installeren in dit document): een moderne, promise-based Node-IMAP-client (bijv. `imapflow`) — geen nieuw architecturaal besluit, gewoon de meest voor de hand liggende keuze wanneer daadwerkelijk gebouwd wordt.

### 4.2 Authenticatiemethoden — af te wegen zodra bekend welke de provider ondersteunt

| Methode | Wanneer van toepassing | Least-privilege-overweging |
|---|---|---|
| **Gewone username/password** | Standaard IMAP-basisauthenticatie (`LOGIN`), werkt bij de meeste hostingproviders zolang IMAP-toegang niet apart geblokkeerd is | Voorkeur: een **aparte, dedicated credential** voor deze mailbox-toegang, niet het "hoofdwachtwoord" van het account (indien de provider meerdere inlogmethoden/toepassingswachtwoorden ondersteunt) |
| **App-specifiek wachtwoord** | Vereist door providers die 2FA/MFA afdwingen op het account en daardoor plain-password IMAP-login blokkeren voor het hoofdaccount | **Aanbevolen boven het echte accountwachtwoord waar beschikbaar** — apart intrekbaar, geen toegang tot andere accountfuncties (webmail-instellingen, etc.), exact het least-privilege-principe dat de opdracht vraagt |
| **OAuth2 (XOAUTH2/OAUTHBEARER)** | Alleen indien de provider dit voor IMAP ondersteunt (niet universeel — veel kleinere hostingproviders bieden dit niet) | Sterkste optie indien beschikbaar (kortlevend token i.p.v. een statisch wachtwoord), maar vereist een eigen app-registratie/consent-traject bij díe specifieke provider — pas te ontwerpen zodra bekend is welke provider `info@stones4u.eu` host en of die OAuth aanbiedt |

**Aanbevolen volgorde van voorkeur**: app-specifiek wachtwoord (indien de provider dit biedt) > OAuth2 (indien ondersteund, met de kanttekening dat dit meer opzet vergt) > gewoon accountwachtwoord (laatste keuze, alleen als geen van beide andere opties bestaat). Definitief te bepalen zodra de provider bekend is (§12).

### 4.3 Zoeken, richting, threading

- **Zoeken**: IMAP `SEARCH` is per-folder, niet mailbox-breed zoals Graph's `$search` — dit is een structureel protocolverschil, geen tekortkoming van het ontwerp. Voor inbound-kandidaten: `SELECT INBOX` gevolgd door `SEARCH HEADER FROM "{addr}"`. Voor outbound-kandidaten: `SELECT <sent-folder>` gevolgd door `SEARCH OR HEADER TO "{addr}" HEADER CC "{addr}"`.
- **Richting**: **structureel bepaald door welke folder doorzocht is** (Postvak IN → `INBOUND`, Verzonden-map → `OUTBOUND`) — geen header-vergelijking nodig, in zekere zin nóg directer dan de Graph-aanpak (§3.5).
- **Verzonden-map-naam**: niet gestandaardiseerd tussen providers (`Sent`, `Sent Items`, `INBOX.Sent`, etc.). Voorkeursaanpak: IMAP `LIST` met de `SPECIAL-USE`-extensie (RFC 6154) om de map met de `\Sent`-vlag te vinden; fallback op een kleine lijst gangbare namen als de provider `SPECIAL-USE` niet ondersteunt. **Empirisch te bevestigen zodra `info@stones4u.eu`'s daadwerkelijke provider bekend is** (§12) — niet vooraf aan te nemen.
- **Threading**: IMAP heeft geen directe `conversationId`-equivalent zoals Graph. `References`/`In-Reply-To`-headers kunnen client-side gebruikt worden om een thread-sleutel af te leiden, maar dit is minder betrouwbaar dan Graph's ingebouwde veld — `conversationId` blijft `null` waar niet betrouwbaar afleidbaar (nooit verzonnen, conform het generieke model, §2).
- **Origineel bericht openen**: geen universeel IMAP-equivalent van Graph's `webLink` — `webLink` is voor IMAP-berichten standaard `null`. Indien de uiteindelijke provider een bekend, stabiel webmail-URL-patroon heeft (bijv. Roundcube- of cPanel-webmail-achtige deep links), is dat een latere, aparte, providerspecifieke toevoeging — niet vooraf aan te nemen.
- **Stabiliteit van UID's**: een IMAP-UID is alleen stabiel binnen een gegeven `UIDVALIDITY`-waarde voor een map; als die ooit wijzigt (zeldzaam, maar mogelijk bij servertechnische reorganisatie), zijn eerdere UID's niet meer betekenisvol. Omdat niets lokaal opgeslagen wordt (categorie B, ADR-008), is dit onschadelijk voor de data zelf — maar de synthetische timeline-ID neemt `uidValidity` daarom bewust op (§8) om een ID-botsing na een eventuele reset uit te sluiten.

### 4.4 Wat hier expliciet niet gebeurt

Geen verbinding wordt gelegd, geen bibliotheek geïnstalleerd, geen env-var vastgelegd (§12) — dit is uitsluitend het interfaceontwerp, klaar om ingevuld te worden zodra de providergegevens bekend zijn.

## 5. Datamodel — herziene `MonitoredMailbox`

```
enum EmailProvider {
  MICROSOFT365
  IMAP
}

model MonitoredMailbox {
  id           String        @id @default(cuid())
  emailAddress String        @unique
  displayName  String?
  provider     EmailProvider
  enabled      Boolean       @default(true)
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
}
```

Exact de door de opdracht gevraagde minimale velden — **geen wachtwoorden, geen OAuth-tokens, geen enkele credential** in deze tabel, ongeacht provider. Dit vervangt het eerdere `ConnectedMailbox`/`MonitoredMailbox`-ontwerp met versleutelde tokenkolommen volledig: voor Microsoft 365 was dat al overbodig (tenant-brede app-credential, §3.1); voor IMAP is het nu even bewust uitgesloten — de credential (wachtwoord/app-wachtwoord/OAuth-token) hoort uitsluitend server-side als secret/env-config, nooit in PostgreSQL (§4.2, herbevestigd in §11).

**Niet meegenomen, bewust**: een `addedByUserId`/audit-trail-veld (aanwezig in een eerdere documentversie) is geen onderdeel van de door de opdracht gevraagde minimale set — kan als latere, niet-blokkerende toevoeging overwogen worden (wie heeft deze mailbox toegevoegd), maar is geen vereiste voor Phase 3C zelf.

## 6. `MatchSource` — generiek `EMAIL`, geen provider-specifieke waarden

De opdracht vraagt expliciet een afweging: provider-specifieke match-sources (`MICROSOFT365`/`IMAP`) versus een generieke `EMAIL`-waarde. **Aanbeveling: generiek `EMAIL`** — dit **herroept** de aanbeveling uit de vorige documentversie (die `MICROSOFT365` als matchsource voorstelde, vóórdat het tweede-provider-scenario bekend was).

**Onderbouwing**:

- `ExternalContactMatch.externalRef` voor e-mail is het genormaliseerde e-mailadres **van de klant** — dit is exact dezelfde waarde, met exact dezelfde betekenis ("deze `CustomerProfile` gebruikt dit adres"), ongeacht via welke Stones4U-mailbox/provider een bericht met dat adres gezien werd. Het is één feit over de klant, geen twee.
- Een provider-specifieke matchsource zou datzelfde feit (klant X ↔ adres Y) kunnen laten uiteenvallen in twee losse rijen (één via `MICROSOFT365`, één via `IMAP`) als hetzelfde klantadres ooit in beide mailboxen voorkomt — dat doorbreekt de bedoelde dedup-garantie van de `@@unique([customerProfileId, source, externalRef])`-constraint en zou een medewerker twee keer dezelfde match laten bevestigen.
- Vergelijk met `OFFERTEAPP`/`S4U_QUOTE_APP`: die zijn terecht apart, omdat het daadwerkelijk **twee losstaande bedrijfssystemen** met eigen offertegegevens zijn — de bron identificeert daar welk bedrijfsrecord bedoeld wordt. Bij e-mail is het providerverschil (Graph vs. IMAP) puur een **transportmechanisme** om dezelfde soort onderliggende klantcommunicatie te lezen — geen apart bedrijfsrecordsysteem. Dat verschil hoort dus niet op matching-niveau, maar op berichtniveau (`NormalizedEmailMessage.provider`/`.mailboxAddress`, §2) — en daar staat het al.
- **Consequentie**: `MICROSOFT365` wordt **niet** toegevoegd aan `MatchSource` (in tegenstelling tot de vorige documentversie). In plaats daarvan: één nieuwe waarde, `EMAIL`, additief aan de bestaande enum. Het al gedeployde, ongebruikte `GMAIL`-lid blijft **ongewijzigd, niet destructief verwijderd** — herbevestigd, conform de opdracht.

```
enum MatchSource { TELEFOONSYSTEEM, GMAIL, EMAIL, OFFERTEAPP, S4U_QUOTE_APP }
```

(`GMAIL` blijft staan als legacy/ongebruikt lid — zie de eerdere correctieronde en `docs/architecture/ADR-007-CUSTOMER-MATCHING-LAYER.md` voor de volledige onderbouwing van waarom dit lid niet met terugwerkende kracht verwijderd wordt.)

## 7. Customer matching — participant-gebaseerd, nooit fuzzy

Toepassing van het bestaande ADR-007 op e-mail-participanten, met specifieke aandacht voor het door de opdracht genoemde meerdere-ontvangers-risico:

- **Inbound**: de afzender (`from`) is de primaire matchkandidaat.
- **Outbound**: de ontvangers (`to`, en `cc` waar relevant) zijn de matchkandidaten.
- **Matching is altijd exact, per volledig genormaliseerd adres** (`normalizeEmail()`) — nooit op domein, nooit op naam, nooit gedeeltelijk. Een adres dat letterlijk niet overeenkomt, matcht nooit "waarschijnlijk."
- **Eén bericht kan legitiem bij meerdere klanten horen** — als een uitgaand bericht naar zowel klant A als klant B is verzonden (bijv. cc), en beide adressen matchen elk een eigen, ondubbelzinnige `CustomerProfile`, is het **correct** dat dit bericht op beide Customer-360-pagina's verschijnt: dat zijn twee echte, geverifieerde deelnemers, geen foutieve koppeling. Dit is geen ambiguïteit — ambiguïteit is iets anders (zie volgende punt).
- **De daadwerkelijke ambiguïteit om tegen te beveiligen**: wanneer **hetzelfde** e-mailadres bij **meerdere** `CustomerProfile`-rijen hoort (bijv. een gedeeld/familie-/bedrijfsadres dat aan twee Shopify-klantrecords gekoppeld is) — dan geldt onverkort ADR-007 regel 2: dit wordt opgeslagen/getoond als `AMBIGUOUS`, nooit stilzwijgend aan één van de kandidaten toegewezen. Een e-mailadres wordt dus nooit "geraden" naar een klant; het wordt of ondubbelzinnig gematcht, of expliciet als onzeker gemarkeerd voor menselijke keuze.
- **Geen brede/OR-achtige matchquery op andere velden** (onderwerp, naam, domein) — uitsluitend exacte, genormaliseerde adresvergelijking. Dit is de garantie die voorkomt dat een bericht "zonder zekerheid" aan een verkeerde klant gekoppeld wordt, zoals de opdracht expliciet vraagt.

## 8. Timeline — provider-aware stabiele ID's (ADR-008)

`EMAIL_INBOUND`/`EMAIL_OUTBOUND` blijven categorie B (nooit opgeslagen), ongewijzigd. Synthetische ID's, exact zoals de opdracht voorstelt:

```
m365-{mailboxId}-{messageId}
imap-{mailboxId}-{uidValidity}-{uid}
```

`mailboxId` is `MonitoredMailbox.id` (CRM-intern) — dit garandeert dat twee verschillende mailboxen/providers nooit kunnen botsen, zelfs in het (zeer onwaarschijnlijke) geval dat twee providers toevallig identiek gevormde message-ID's zouden opleveren. `uidValidity` in het IMAP-formaat beschermt specifiek tegen een ID-hergebruik na een IMAP-UIDVALIDITY-reset (§4.3).

## 9. Customer 360 — UX, mailbox-adres zichtbaar waar relevant

Ongewijzigd basisprincipe (0 nieuwe top-level tabs, zie `28-PHASE-3-ARCHITECTURE.md` §4):

1. **Overzicht** — compact blok **"Recente e-mails"**, samengevoegd over beide mailboxen (niet per mailbox een apart blok) — visueel naast het "Recente gesprekken"-blok (telefonie), zelfde stijl.
2. **Activiteit** — `EMAIL_INBOUND`/`EMAIL_OUTBOUND` chronologisch tussen de overige event-types.
3. **Bronvermelding**: elk e-mail-tijdlijn-item toont, wanneer relevant (bijv. zodra Stones4U meer dan één mailbox actief heeft, wat vanaf Phase 3C per direct het geval is), via welk Stones4U-adres het bericht liep — `info@stones4u.nl` of `info@stones4u.eu` — als een klein, secundair label (zelfde visuele gewicht als bijv. een statuslabel bij offertes), nooit prominenter dan de klantgerichte informatie (onderwerp/afzender/datum) zelf.

**Resultaat**: nog steeds 7 tabs — ongewijzigd t.o.v. het al bevestigde uitgangspunt.

## 10. Fail-safe — elke mailbox/provider onafhankelijk

Rechtstreeks gegarandeerd door de architectuur in §1 (`Promise.allSettled` over sub-adapters, geen enkele afhankelijkheid tussen mailboxen):

- Microsoft Graph onbereikbaar (timeout, 5xx, throttling, RBAC-scopingfout) → `Microsoft365EmailAdapter` levert `available: false` of een lege set voor die mailbox; `ImapEmailAdapter` (indien geconfigureerd) functioneert onveranderd door.
- IMAP-server onbereikbaar (netwerk, verkeerde credential, TLS-fout) → omgekeerd, exact hetzelfde: Graph blijft door functioneren.
- Beide onbereikbaar → `EmailAdapter.status()` meldt `available: false` (of `"partial"` als één van de twee wél werkt maar de andere niet — zie de `status()`-vorm in §1), Overzicht-/Activiteit-secties tonen simpelweg geen e-mail-items voor de getroffen bron(nen). **Customer 360 als geheel blijft altijd volledig bruikbaar** — nooit een crash, ongeacht welke combinatie van mailboxen beschikbaar is.
- Eén mailbox met een configuratiefout (bijv. RBAC-scoping niet correct ingesteld, zie de valkuil in §3.2) faalt geïsoleerd — nooit een reden voor de andere mailbox of de rest van de pagina om ook te falen.

## 11. Verwachte configuratie (indicatief — niet aan te maken in dit document)

**Microsoft 365** (`info@stones4u.nl`), tenant-breed, geen per-mailbox-secret:
```
MICROSOFT_GRAPH_TENANT_ID=
MICROSOFT_GRAPH_CLIENT_ID=
MICROSOFT_GRAPH_CLIENT_SECRET=      # of later: certificate-config, zie §3.1
```

**IMAP** (`info@stones4u.eu`) — **geen definitieve namen vastgelegd**, patroon indicatief:
```
IMAP_INFO_STONES4U_EU_HOST=          # onbekend, zie §12
IMAP_INFO_STONES4U_EU_PORT=          # onbekend, zie §12
IMAP_INFO_STONES4U_EU_SECURE=        # onbekend (implicit TLS vs. STARTTLS), zie §12
IMAP_INFO_STONES4U_EU_USERNAME=
IMAP_INFO_STONES4U_EU_AUTH_METHOD=   # PASSWORD | OAUTH2, zie §4.2
IMAP_INFO_STONES4U_EU_CREDENTIAL=    # wachtwoord, app-wachtwoord, of OAuth-token — Fly secret, NOOIT in PostgreSQL
```

Geen van beide groepen bevat het mailboxadres/de mailboxlijst zelf als geheim — die staat in `MonitoredMailbox` (§5), wat geen credentials bevat en dus geen geheime tabel is.

## 12. Wat exact nog nodig is voor `info@stones4u.eu`

Vóór de IMAP-adapter daadwerkelijk geconfigureerd kan worden, expliciet ontbrekend:

1. **IMAP-hostname** (bijv. `mail.stones4u.eu`, `imap.hostingprovider.nl`, etc. — afhankelijk van wie het `.eu`-domein/mailbox host).
2. **IMAP-poort** (typisch 993 voor implicit TLS, 143 met STARTTLS — te bevestigen, niet aan te nemen).
3. **TLS-vorm** (implicit TLS vs. STARTTLS vs., in het slechtste geval, geen TLS — dat laatste zou een blokkerend beveiligingsprobleem zijn, niet te accepteren voor een credential die een echte mailbox opent).
4. **Ondersteunde authenticatiemethode(n)**: gewoon wachtwoord, app-specifiek wachtwoord, en/of OAuth2 (§4.2) — welke de provider daadwerkelijk aanbiedt.
5. **Sent-map-naam/detectie**: of de provider `SPECIAL-USE` (RFC 6154) ondersteunt, of een handmatig te bevestigen mapnaam nodig is (§4.3).
6. **Wie de mailbox beheert**: wie bij (of namens) Stones4U toegang heeft om een dedicated/app-specifiek credential voor deze mailbox aan te maken, zonder het eigenlijke accountwachtwoord te hergebruiken.

Zonder deze zes punten kan de IMAP-adapter **niet** geconfigureerd of getest worden — het ontwerp (§1, §4) staat er wel al klaar voor.

## 13. Buildvolgorde (Phase 3C, definitief, provider-onafhankelijk)

1. Migratie: `MonitoredMailbox` (§5) + `EmailProvider`-enum + additieve `ALTER TYPE "MatchSource" ADD VALUE 'EMAIL'` (§6) — handmatig SQL-gereviewd, zelfde discipline als elke eerdere migratie.
2. `src/integrations/email/types.ts`: `NormalizedEmailMessage` en gedeelde types (§2).
3. `src/integrations/email/microsoft365-adapter.ts`: Graph-client (MSAL, client-credentials), `$search`-implementatie, richtingsbepaling (§3) — **kan als eerste gebouwd worden**, alle benodigde gegevens zijn al bekend (tenant, mailbox, permission-strategie), mits de Exchange Online RBAC-configuratie (§3.2, door een tenant-beheerder, buiten dit repo) vooraf is uitgevoerd.
4. `src/integrations/email/imap-adapter.ts`: **wacht op de zes punten in §12** — het interfaceontwerp staat klaar, de daadwerkelijke connectielogica pas na die gegevens.
5. `src/integrations/email/adapter.ts`: samenstellende `EmailAdapter`, `Promise.allSettled` over actieve `MonitoredMailbox`-rijen (§1, §10).
6. Matching-integratie (`src/modules/matching/`) — participant-gebaseerd, §7, hergebruikt bestaande `matchByEmail`/`normalizeEmail()`.
7. Timeline-projectie (`src/modules/activity/timeline.ts`) — `EMAIL_INBOUND`/`EMAIL_OUTBOUND`, stabiele ID's (§8).
8. UI: Overzicht-blok, Activiteit-icoon, bronlabel (§9).
9. Tests: adapter-fail-safe (elk apart, en gecombineerd — §10), matching (exact/ambigu/multi-recipient, §7), normalisatie.
10. **Microsoft 365-pad kan zelfstandig live gaan vóórdat IMAP klaar is** — de architectuur staat dit toe (§1/§10: één ontbrekende/niet-geconfigureerde mailbox degradeert nooit de andere) — een gefaseerde Phase 3C-oplevering (eerst `info@stones4u.nl`, later `info@stones4u.eu` zodra §12 is opgelost) is dus een reële, aan te bevelen optie, geen architecturale beperking.
11. `docs/build/PHASE-3C-IMPLEMENTATION-REPORT.md` + staging-deploy + smoke test — zelfde discipline als Phase 1/2/3A/3B.
12. **Geen productie-deploy in dit document** — latere, apart te autoriseren stap.

## 14. Open beslissingen — input van Fons nodig

1. **Microsoft 365 RBAC-beheerderstoegang**: wie configureert de Exchange Online RBAC-for-Applications-roltoewijzing voor `info@stones4u.nl` (§3.2)? Vereist Exchange Administrator- of gelijkwaardige rechten.
2. **`info@stones4u.eu`-providergegevens**: de zes punten uit §12 — wie kan deze opzoeken/aanleveren (hostingprovider-paneel, eerdere configuratie-e-mail, etc.)?
3. Client-secret vs. certificaat voor de Microsoft 365-app-registratie (§3.1) — niet blokkerend voor een eerste implementatie.
4. Voor IMAP: welk authenticatietype de uiteindelijke provider aanbiedt (§4.2), en wie een dedicated/app-specifiek credential kan aanmaken.
5. RBAC for Applications vs. het oudere Application Access Policy-mechanisme (§3.2) — RBAC for Applications is de aanbevolen, huidige route; Application Access Policy blijft een werkende, eenvoudigere fallback als de beheerder daar al bekend mee is. Geen technische blokkade, wel een voorkeur uit te spreken.
6. **Volgorde**: eerst Microsoft 365 alleen live (mogelijk zodra §3.2 is uitgevoerd), IMAP later toevoegen zodra §12 is opgelost — of wachten tot beide klaar zijn voordat Phase 3C als geheel oplevert? Dit document adviseert **niet wachten** (§13 punt 10), maar dit is Fons' keuze.

## 15. Wat dit document bewust niet doet

Zelfde expliciete out-of-scope-lijst als eerder, herbevestigd: geen mail verzenden, geen complete mailclient, geen drafts-beheer, geen mailbox-foldersbeheer, geen bijlagen naar R2 kopiëren, geen volledige mailbox-indexering, geen AI-index over mailinhoud. Ook: geen Prisma-migratie, geen code, geen env secrets, geen deploy, geen concrete IMAP-verbinding — dit is uitsluitend een documentatie-/architectuurcorrectie.
