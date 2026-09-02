import { CustomerSearch } from "./CustomerSearch";

export default function CustomersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-primary">Klanten</h1>
        <p className="mt-1 text-sm text-ink-tertiary">Zoek een klant in Shopify om Customer 360 te openen.</p>
      </div>
      <CustomerSearch />
    </div>
  );
}
