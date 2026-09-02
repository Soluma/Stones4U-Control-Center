# Phase 1 — Premium UI/UX Pass

Datum: 2026-08-31
Scope: uitsluitend visuele/UX-laag van het reeds gebouwde Stones4U Control Center Phase 1. Geen Phase 2, geen nieuwe businessfunctionaliteit, geen wijzigingen aan auth-logica, API-contracten, Shopify-queries of Prisma-schema. Geen deploy. Alle wijzigingen binnen `CRM/`.

## 1. Belangrijkste visuele wijzigingen

- Nieuw, samenhangend design-token-systeem in `tailwind.config.ts` / `globals.css` (canvas/surface/surface-hover/border-subtle/border/border-strong, ink-primary/secondary/tertiary/disabled, accent-50..700, success/warning/danger, radii md/lg/xl, schaduwen xs/card/popover) — vervangt de eerdere ad-hoc Bootstrap-achtige stijl (grote radii, zware schaduwen, willekeurige spacing).
- Iconografie geïntroduceerd via `lucide-react` in de volledige applicatie (sidebar, topbar, knoppen, empty states, timeline, command palette) — voorheen tekst-only.
- App Shell herbouwd: Sidebar toont actieve-route highlighting (via `usePathname()`), iconen per item, "Binnenkort"-badges consistent gestyled; Topbar toont contextuele paginatitel, zoekveld met `⌘K`-hint, avatar en logout-icoonknop.
- Command Palette uitgebreid met toetsenbord-navigatie (pijltjestoetsen + actieve rij-highlight), footer met sneltoetshints, laad-/geen-resultaten-states.
- Dashboard: taak­samenvatting per tegel voorzien van icoon; "Klant opzoeken" quick-start kaart met icoon i.p.v. platte tekstlink.
- Klant-zoeken: skeleton-loading state, lege/foutstates met passend icoon (in plaats van kale tekst), avatar per resultaat, toetsenbordnavigatie behouden.
- Customer 360-header: compacte statistiekblokken i.p.v. grote KPI-kaarten, avatar, zichtbare-maar-niet-dominante "Notitie toevoegen"/"Taak toevoegen" snelkoppelingen (alleen zichtbaar met schrijfrechten).
- Activity Timeline significant verbeterd: elk event-type (Shopify-order, notitie aangemaakt/gewijzigd/verwijderd, taak aangemaakt/status/toegewezen/afgerond/geannuleerd, klantprofiel bijgewerkt, call, invoice) heeft een eigen icoon en kleurtint; items gegroepeerd per dag ("Vandaag", "Gisteren", datum); timeline-rail i.p.v. losse gekleurde kaarten — schaalbaar voor toekomstige event-types.
- Notities: composer, bewerken/verwijderen via icoonknoppen, avatar per auteur, skeleton-loading, lege-staat met icoon.
- Taken (klantpaneel én centrale Taken-pagina): prioriteit nu zichtbaar via een statuspunt (voorheen nergens getoond), aanmaken via dialoog i.p.v. inline formulier, subtiele achterstallig-markering (rode tekst + label, geen schreeuwerige kleur).
- Admin Gebruikers: professionele tabel-layout, aanmaken via dialoog.
- Login-pagina en instellingen herbouwd met gedeelde `Button`/`Input`-componenten en merk-icoon consistent met de sidebar.

## 2. Gewijzigde componenten/schermen

Nieuwe gedeelde componentbibliotheek (`src/components/ui/`): `Button`, `IconButton`, `Input`/`Textarea`/`Select`, `Avatar`, `Dialog` (toegankelijke modal met focus-trap, Escape, backdrop-click, focus-restore), `Table`-primitieven, `Tabs` (generiek, zowel server-navigatie als client-state), `Badge`/`StatusDot`, `Skeleton`/`SkeletonRow`/`SkeletonList`, `EmptyState`, `RichTextView` (ongewijzigd hergebruikt).

Herbouwde schermen/onderdelen: Sidebar, Topbar, PageContext (nieuw), LogoutButton, CommandPalette, Dashboard, CustomerSearch, CustomerHeader, Tabs (klantpagina — oude losse implementatie verwijderd, vervangen door de gedeelde `Tabs`-component), OrdersTable, ActivityTimelineView, AdapterStatusBanner, NotesPanel, TasksPanel, CrmStatusControl, TasksList (centrale Taken-pagina), UsersAdmin, LoginForm/login-pagina, ChangePasswordForm, globale error-pagina.

Geen wijzigingen aan: API-routes, Prisma-schema, auth/permissie-logica, Shopify-queries, businessregels van taken/notities.

## 3. Regressies gevonden en opgelost

- **Lege-takenlijst toonde een storende extra randlijn**: zowel `TasksPanel.tsx` (klantpaneel) als `TasksList.tsx` (centrale Taken-pagina) renderden de `cc-card divide-y`-wrapper onvoorwaardelijk, ook wanneer de takenlijst leeg was — dit gaf een zichtbare lege gerande balk onder de "Geen taken"-melding. Gevonden via visuele screenshot-review (niet via code-only audit). Opgelost door de wrapper alleen te renderen wanneer `tasks !== null && tasks.length > 0`. Geverifieerd via een nieuwe schone rebuild en herhaalde screenshotcapture.
- Geen overige functionele regressies gevonden. Login/logout, dashboard, klant zoeken, Customer 360, orders, notities CRUD, taken CRUD, activiteitentijdlijn, Command Palette, admin gebruikers en instellingen zijn stuk voor stuk handmatig doorlopen (VIEWER-testaccount) op 1366×768 en 1920×1080 en werken zoals voorheen.

## 4. Tests/build-resultaat (na de fix, definitieve run)

- `npm run typecheck` → geslaagd, geen fouten.
- `npm run lint` → geslaagd, geen waarschuwingen/fouten.
- `npm run test` (Vitest) → **43/43 tests geslaagd** (12 testbestanden). De zichtbare stderr/stdout-regels in de output zijn verwachte log-uitvoer van tests die bewust foutpaden testen (transient Shopify 500-retry, niet-transiente GraphQL-fout, audit-write die faalt op een FK-constraint) — geen daadwerkelijke testfouten.
- `npm run build` (`next build --turbopack`, `output: "standalone"`) → geslaagd. 21 statische/dynamische routes correct gegenereerd, geen type- of buildfouten.

## 5. Screenshots/documentatie

14 screenshots vastgelegd onder `docs/ui-review/` (login, dashboard, klanten-zoeken, taken, admin-gebruikers, instellingen, command-palette — elk op 1366×768 en 1920×1080), gemaakt met het VIEWER-testaccount (`viewer@stones4u.local`) tegen een lokale dev-server. Geen echte klantgegevens in de screenshots. Alle 14 zijn visueel gecontroleerd op overflow, uitlijning, spacing, hydration-/consolefouten en hover/focus-states — geen console-errors gerapporteerd door de Playwright-capture op beide viewports, geen visuele defecten meer aanwezig na de takenlijst-fix.

## 6. Resterende visuele beperkingen

- De diagnostische route `/api/admin/shopify-scopes` en de admin-only secties (bv. gebruikersbeheer met een échte ADMIN-account) zijn niet visueel geverifieerd met een ADMIN-gebruiker, omdat er geen werkend ADMIN-wachtwoord beschikbaar was in de lokale dev-database op het moment van testen (de eerder gebootstrapte `admin@stones4u.local` bestond niet meer; een echte ADMIN-gebruiker (`fons@verkoelengroep.nl`) is bewust niet benaderd/omzeild). De admin-gebruikerspagina is wel geverifieerd voor het correct geblokkeerde VIEWER-pad ("Deze pagina is alleen beschikbaar voor beheerders.").
- Dark mode is bewust niet gebouwd (expliciet uitgesloten in de opdracht).
- Geen geautomatiseerde visuele-regressietests (bv. Percy/Chromatic) toegevoegd — verificatie is dit moment gebaseerd op handmatige screenshot-review, conform de scope van deze pass.
