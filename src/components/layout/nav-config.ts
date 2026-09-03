import {
  LayoutDashboard,
  Users,
  CheckSquare,
  FileText,
  ShoppingCart,
  Truck,
  Factory,
  PackageCheck,
  LifeBuoy,
  UserCog,
  Settings,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  label: string;
  href?: string;
  icon: LucideIcon;
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
  { label: null, items: [{ label: "Dashboard", href: "/", icon: LayoutDashboard }] },
  {
    label: "CRM",
    items: [
      { label: "Klanten", href: "/customers", icon: Users },
      { label: "Taken", href: "/tasks", icon: CheckSquare },
    ],
  },
  {
    label: "Sales",
    items: [
      // Phase 4a — docs/architecture/ADR-009-OPPORTUNITY-PIPELINE-MODEL.md.
      // A new capability, not a rename of the offerte-/orderoverzichten
      // below (those stay federated-document placeholders, untouched by
      // Phase 4a — docs/platform-discovery/32 §7/§20).
      { label: "Verkoopkansen", href: "/opportunities", icon: TrendingUp },
      { label: "Offertes", icon: FileText, comingSoon: true },
      { label: "Orders", icon: ShoppingCart, comingSoon: true },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Inkoop", icon: Truck, comingSoon: true },
      { label: "Productie", icon: Factory, comingSoon: true },
      { label: "Leveringen", icon: PackageCheck, comingSoon: true },
    ],
  },
  { label: "Service", items: [{ label: "Service", icon: LifeBuoy, comingSoon: true }] },
  {
    label: "Beheer",
    items: [
      { label: "Gebruikers", href: "/admin/users", icon: UserCog },
      { label: "Instellingen", href: "/settings", icon: Settings },
    ],
  },
];
