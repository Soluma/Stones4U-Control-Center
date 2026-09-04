# 48 — Phase 6B Build Spec: Mijn Klanten & Klanttoewijzing

**Status**: Build spec, geen implementatie. Vervolg op
`47-PHASE-6B-MY-CUSTOMERS-ARCHITECTURE.md`. Klaar om te bouwen na
expliciete opdracht — dit document zelf bouwt niets.

## 1. IN scope

1. `listCustomerProfiles(actor, { scope, search?, page?, pageSize? })` in
   `customer-profile.service.ts` — zie architectuurdoc §4 voor de exacte
   query-vorm. `pageSize` default 25 (geen harde eis, presentatiedetail).
2. `getCustomerListCounts(actor)` — drie `count()`-aanroepen
   (`mine`/`unassigned`/`all`), `Promise.all()`.
3. `GET /api/customers?scope=&q=&page=` (nieuw) — `requireUser()`-gated,
   retourneert `{ customers, total, counts }`.
4. Client-side uitbreiding van `/customers`-pagina: bestaande
   `CustomerSearch` blijft bovenaan ongewijzigd; nieuwe `Tabs` (Mijn
   klanten/Niet toegewezen/Alle klanten, met counts) + lijst + zoekveld
   binnen scope + paginering eronder.
5. "Aan mij toewijzen"-knop op Niet-toegewezen-rijen, zichtbaar voor
   ADMIN/AGENT — roept `PATCH /api/customers/[id]` aan met
   `{ accountManagerId: undefined }` **vervangen door de server-side
   actor** — d.w.z. de client stuurt geen expliciete waarde door de eigen
   sessie-actor te vertrouwen op de server; concreet: de bestaande
   `PATCH`-route/`updateCustomerCrmFields()` blijven ongewijzigd (ze
   accepteren al `accountManagerId` van de request-body), dus de
   quickaction-knop stuurt gewoon `{ accountManagerId: <server-bekende
   actor-id, opgehaald via de sessie in de aanroepende server action of
   client-call> }` — **exacte implementatiekeuze (server action met
   `getSessionUser()` vs. client die de al-bekende ingelogde-gebruikers-id
   gebruikt) bij bouw te bepalen, met de harde eis dat de uiteindelijke
   geschreven waarde altijd verifieerbaar de ingelogde sessie-actor is,
   nooit een vrij client-veld.**
6. Klein dashboard-linkje naar `/customers?scope=mine` in de bestaande
   Mijn Werk-sectie.
7. Accountmanager-badge (met inactief-indicator) op Niet-toegewezen/Alle-
   rijen.

## 2. OUT of scope (zie architectuurdoc §13 voor motivatie)

- Bulk assignment
- ADMIN-medewerkerfilter (Accountmanager: [Fons]/[Piet]/[Onbekend])
- Live Shopify-klantenlijst/-browsing
- Territory management, workload balancing, auto-assignment
- Opportunity/Task-herverdeling gekoppeld aan accountmanager-wijziging
- Notificaties
- Nieuwe route/mutatie-logica voor gewone accountmanager-toewijzing
  (Customer 360's bestaande `AccountManagerControl` blijft de volledige
  toewijzingsflow; "Aan mij toewijzen" is uitsluitend een snelkoppeling
  naar dezelfde bestaande mutatie)

## 3. Datamodel-impact

Geen. Geen migratie.

## 4. API-impact

Eén nieuwe route: `GET /api/customers`. Geen wijziging aan `PATCH
/api/customers/[id]` (al voldoende, zie discovery §3).

## 5. UI-impact

`/customers`-pagina uitgebreid (nieuwe tabs/lijst/zoek/paginering-
componenten), klein linkje op het dashboard. Geen wijziging aan
Customer 360.

## 6. RBAC

`GET /api/customers`: `requireUser()`. "Aan mij toewijzen":
`requireWriteAccess()` (via de bestaande `PATCH`-route, ongewijzigd).

## 7. Audit

Geen nieuwe audit voor de lijst. "Aan mij toewijzen" audit via de
bestaande `customer_profile.updated`-actie (ongewijzigd).

## 8. Performance

Geen nieuwe index (architectuurdoc §10). Geen N+1. Geen externe
aanroepen.

## 9. Tests

Minimaal:

**Mine**: eigen-toegewezen klant inbegrepen; andere-accountmanager-klant
uitgesloten; niet-toegewezen klant uitgesloten; ADMIN ziet binnen "mine"
alleen eigen klanten (geen bypass).

**Unassigned**: `accountManagerId = null` inbegrepen; toegewezen klant
uitgesloten, ongeacht wie.

**All**: elke lokaal bestaande klant leesbaar, voor elke rol inclusief
VIEWER.

**Search**: scope blijft behouden tijdens zoeken (een zoekterm binnen
"mine" geeft nooit een klant van een andere accountmanager terug, ook
niet als de naam matcht); zoekt op zowel `displayName` als
`companyName`; paginering correct na filter+zoek.

**RBAC**: VIEWER kan lezen (alle drie scopes), VIEWER kan niet
"Aan mij toewijzen" (403 via de bestaande write-guard).

**Identity**: organisatie- en individu-presentatie via
`customerDisplayName()`/`customerSecondaryName()`, geen dubbele logica.

**Assignment ("Aan mij toewijzen")**: zet `accountManagerId` naar de
server-side actor, nooit een client-aangeleverde waarde; audit-metadata
bevat correcte before/after. **Concurrency (vastgesteld tijdens de final
review vóór commit, 2026-09-04 — niet eerder expliciet besloten in dit
document)**: een blinde `update` zou een last-write-wins-race toestaan
(medewerker B overschrijft stil de toewijzing die medewerker A een
moment eerder deed). Geïmplementeerd als een conditionele
`updateMany({ where: { id, accountManagerId: null }, ... })` —
slaagt alleen als de klant op het moment van schrijven nog daadwerkelijk
niet-toegewezen is; retourneert anders `null` (route: HTTP 409), zonder
enige Activity/AuditEvent te schrijven. Geen tweede bron van waarheid —
één atomaire, voorwaardelijke database-operatie.

**Inactive accountmanager**: een klant met een inmiddels-inactieve
accountmanager blijft in "Alle klanten" met die naam + inactief-
indicator zichtbaar, verschijnt **niet** in "Niet toegewezen".

**No coupling**: een accountmanager-wijziging via deze flow verandert
nooit `Opportunity.ownerUserId` of `Task.assignedToId` van gerelateerde
records.

## 10. Staging E2E

Zelfde gevestigde patroon (tijdelijke gebruikers, synthetische
`CustomerProfile`-rijen met nep-Shopify-GID's — geen echte Shopify-klant
nodig, exact zoals Phase 6A). Scenario's:

- User A + eigen klant, User B + eigen klant, één niet-toegewezen klant.
- ADMIN met eigen klant + andermans klant.
- `scope=mine` toont alleen eigen klant voor elke rol.
- `scope=unassigned` toont alleen de niet-toegewezen klant.
- `scope=all` toont alle drie, voor elke rol inclusief VIEWER.
- Zoeken binnen `scope=mine` respecteert de scope.
- Organisatie- vs. individu-weergave correct.
- VIEWER: leest alle scopes, "Aan mij toewijzen" niet zichtbaar/leidt tot
  403 indien alsnog aangeroepen.
- "Aan mij toewijzen" wijst correct toe, audit-rij correct.
- Cleanup verplicht, inclusief alle synthetische klanten/gebruikers.

## 11. Beslissingen genomen tijdens bouw (geen architectuurwijziging)

- `pageSize`-default: 25.
- Counts zitten in dezelfde `GET /api/customers`-response (`{ customers,
  total, counts, scope, page }`) — geen apart endpoint.
- "Aan mij toewijzen"'s actor-herkomst: de route resolvet `actor` altijd
  server-side via `requireWriteAccess()`; een `assignToSelf: true`-veld in
  de PATCH-body schakelt naar een dedicated, conditionele
  `updateMany`-toewijzing (zie §9 hierboven) — nooit een client-veld voor
  de doelgebruiker.
