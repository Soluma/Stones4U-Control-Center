export type NavItem = {
  label: string;
  href?: string;
  comingSoon?: boolean;
};

export type NavSection = {
  label: string | null;
  items: NavItem[];
};

// Phase 1 scope per docs/platform-discovery/25 — items without an href are
// real, visible destinations for later phases (docs/platform-discovery/24
// fasering) but render as clearly disabled "Binnenkort" rows, never as a
// fake-functional page.
export const NAV_SECTIONS: NavSection[] = [
  { label: null, items: [{ label: "Dashboard", href: "/" }] },
  {
    label: "CRM",
    items: [
      { label: "Klanten", href: "/customers" },
      { label: "Taken", href: "/tasks" },
    ],
  },
  {
    label: "Sales",
    items: [
      { label: "Offertes", comingSoon: true },
      { label: "Orders", comingSoon: true },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Inkoop", comingSoon: true },
      { label: "Productie", comingSoon: true },
      { label: "Leveringen", comingSoon: true },
    ],
  },
  { label: "Service", items: [{ label: "Service", comingSoon: true }] },
  {
    label: "Beheer",
    items: [
      { label: "Gebruikers", href: "/admin/users" },
      { label: "Instellingen", href: "/settings" },
    ],
  },
];
