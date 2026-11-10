import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { clearUsage, getUsage, setUsagePrice, type ModelPriceInput, type UsageTotals, type UsageView } from "./api.js";
import { ManageUsageLink } from "./ChatGpt.js";

/*
 * The Usage page (issue #70): tokens first, then money kept in separate buckets that are never added together:
 * API spending (reported by the provider, or estimated from a price), and, for ChatGPT plan calls, an optional
 * comparison at published API rates that nobody was charged. Unknown is shown as unknown, never as zero. There is
 * deliberately no plan allowance or limit here: Mivra can't see it, so the page links to ChatGPT's own.
 */

const RANGES = [
  { id: "7", label: "7 days", days: 7 },
  { id: "30", label: "30 days", days: 30 },
  { id: "90", label: "90 days", days: 90 },
  { id: "all", label: "All time", days: null },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const tokenFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const tokens = (n: number | null) => (n === null ? "Unknown" : tokenFormat.format(n));
const compact = (n: number | null) => (n === null ? "Unknown" : compactFormat.format(n));
export function dollars(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** API spending as words: what was reported, what's estimated, and how many calls have no known cost. */
export function spendingText(t: UsageTotals): string {
  const parts: string[] = [];
  if (t.reportedCost !== null) parts.push(`${dollars(t.reportedCost)} reported`);
  if (t.estimatedCost !== null) parts.push(`≈${dollars(t.estimatedCost)} estimated`);
  if (t.unknownCost > 0) parts.push(`${plural(t.unknownCost, "call")} unknown`);
  return parts.length > 0 ? parts.join(" + ") : "None";
}

export function UsagePanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = document.querySelector<HTMLElement>("[data-usage-trigger]") ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
          target?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-heading">Usage</SheetTitle>
          <SheetDescription>
            Tokens and costs from the model calls Mivra makes, counted from when usage tracking started on this computer. It isn't your whole account's usage
            and doesn't show any remaining allowance.
          </SheetDescription>
        </SheetHeader>
        {open && <UsageContent />}
      </SheetContent>
    </Sheet>
  );
}

function UsageContent() {
  const [range, setRange] = useState<RangeId>("30");
  const [view, setView] = useState<UsageView>();
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let stale = false;
    const days = RANGES.find((r) => r.id === range)!.days;
    const from = days === null ? null : new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    void getUsage(from).then((result) => {
      if (stale) return;
      if (result.ok) {
        setView(result.value);
        setError(undefined);
      } else setError(result.error);
    });
    return () => {
      stale = true;
    };
  }, [range, version]);

  return (
    <div className="flex flex-col gap-6 px-4 pb-6">
      <div role="radiogroup" aria-label="Date range" className="flex flex-wrap gap-1">
        {RANGES.map((r) => (
          <Button key={r.id} type="button" size="sm" role="radio" aria-checked={range === r.id} variant={range === r.id ? "secondary" : "ghost"} onClick={() => setRange(r.id)}>
            {r.label}
          </Button>
        ))}
      </div>
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
      {!view && !error && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Spinner aria-hidden="true" /> Loading…
        </p>
      )}
      {view && <UsageReport view={view} onChanged={reload} />}
    </div>
  );
}

function UsageReport({ view, onChanged }: { view: UsageView; onChanged: () => void }) {
  const { totals, api, subscription } = view;
  const empty = totals.calls === 0;
  return (
    <>
      <p className="text-muted-foreground text-sm">
        {view.since ? `Counting since ${new Date(view.since).toLocaleString()}.` : "Nothing recorded yet. Usage is counted from the next model call."}
      </p>
      {!empty && (
        <>
          <section aria-label="Totals" className="grid gap-3 sm:grid-cols-3">
            <Stat label="Tokens" value={compact(totals.total)}>
              <span>{tokens(totals.input)} in · {tokens(totals.output)} out</span>
              {totals.cacheRead !== null && <span>of input, {tokens(totals.cacheRead)} cached</span>}
              {totals.reasoning !== null && <span>of output, {tokens(totals.reasoning)} reasoning</span>}
              {totals.unreported > 0 && <span>{plural(totals.unreported, "call")} didn't report tokens</span>}
            </Stat>
            <Stat label="API spending" value={api.calls === 0 ? "None" : apiHeadline(api)}>
              <span>{plural(api.calls, "API call")}</span>
              {api.calls > 0 && <span>{spendingText(api)}</span>}
            </Stat>
            <Stat label="ChatGPT plan" value={subscription.calls === 0 ? "Not used" : compact(subscription.total)}>
              {subscription.calls > 0 && <span>tokens in {plural(subscription.calls, "call")}, billed to your plan</span>}
              <span>
                Limits and plan usage: <ManageUsageLink />
              </span>
            </Stat>
          </section>
          {subscription.calls > 0 && <ApiEquivalent totals={subscription} />}
          {(totals.incomplete > 0 || totals.unreported > 0) && (
            <p className="text-muted-foreground text-sm">
              {plural(totals.incomplete, "call")} failed or {totals.incomplete === 1 ? "was" : "were"} cancelled. Whatever tokens they reported are counted; calls
              that reported none are shown as unknown rather than free, since a provider may still bill them.
            </p>
          )}
          <DailyChart days={view.days} />
          <Breakdown title="By model" rows={view.byModel.map((m) => ({ key: m.key, name: m.label, detail: m.providerLabel, totals: m, billing: m.billing }))} />
          <Breakdown title="By provider" rows={view.byProvider.map((p) => ({ key: p.key, name: p.label, totals: p, billing: p.billing }))} />
          <Breakdown title="By activity" rows={view.byKind.map((k) => ({ key: k.key, name: k.label, detail: KIND_DETAILS[k.kind], totals: k }))} />
          <Breakdown
            title="Recent runs"
            note="A run is one reply, continuation, lesson or test; each tool-call step is a separate call."
            rows={view.runs.map((r) => ({
              key: r.key,
              name: r.session ?? "Model test",
              detail: `${KIND_SHORT[r.kind]} · ${r.label} · ${new Date(r.startedAt).toLocaleString()}${r.status === "completed" ? "" : ` · ${r.status}`}`,
              totals: r,
              billing: r.billing,
            }))}
          />
          <Breakdown title="Sessions" rows={view.sessions.map((s) => ({ key: s.key, name: s.label, detail: s.deleted ? "Its records are kept" : undefined, totals: s }))} />
        </>
      )}
      <Advanced prices={view.prices} onChanged={onChanged} />
      <ClearHistory disabled={!view.since} onCleared={onChanged} />
    </>
  );
}

const KIND_DETAILS: Record<string, string> = {
  chat: "Your messages and the tutor's replies, syllabus writing included",
  continuation: "The tutor carrying on after you answer its checks",
  lesson: "Background generation of lessons",
  test: "Test model under Model providers",
};
const KIND_SHORT: Record<string, string> = { chat: "Chat", continuation: "Continuation", lesson: "Lesson", test: "Test model" };

function apiHeadline(t: UsageTotals): string {
  const known = (t.reportedCost ?? 0) + (t.estimatedCost ?? 0);
  if (t.reportedCost === null && t.estimatedCost === null) return "Unknown";
  const prefix = t.estimatedCost !== null ? "≈" : "";
  return `${prefix}${dollars(known)}${t.unknownCost > 0 ? "+" : ""}`;
}

function Stat({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1 rounded-md border p-3">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <span className="font-heading text-2xl font-semibold tabular-nums">{value}</span>
      <div className="text-muted-foreground flex flex-col text-xs">{children}</div>
    </div>
  );
}

/** The optional comparison for plan calls. Never added to spending, and not "saved": nothing was charged per token. */
function ApiEquivalent({ totals }: { totals: UsageTotals }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="w-full justify-between">
          Estimated API equivalent
          <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1 px-3 pb-3 text-sm">
        <p className="text-muted-foreground">What these tokens would cost at published API rates. This is not a charge or your subscription cost.</p>
        {totals.apiEquivalent !== null ? (
          <p>
            <span className="font-medium tabular-nums">≈{dollars(totals.apiEquivalent)}</span>
            {totals.uncompared > 0 && <span className="text-muted-foreground"> for the calls with a published price; {plural(totals.uncompared, "call")} had none to compare with.</span>}
          </p>
        ) : (
          <p className="text-muted-foreground">None of these models has a published API price to compare with.</p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Tokens per day, one series. The breakdowns below carry the same numbers as text. */
function DailyChart({ days }: { days: UsageView["days"] }) {
  if (days.length < 2) return null;
  const totalOf = (d: UsageView["days"][number]) => d.api + d.subscription;
  const max = Math.max(1, ...days.map(totalOf));
  return (
    <section aria-labelledby="usage-daily" className="flex flex-col gap-2">
      <h3 id="usage-daily" className="font-heading text-base font-medium">Tokens per day</h3>
      <div className="flex h-28 items-end gap-0.5 border-b" role="list" aria-label="Tokens per day">
        {days.map((d) => {
          const label = `${new Date(`${d.day}T00:00:00`).toLocaleDateString()}: ${tokenFormat.format(totalOf(d))} tokens in ${plural(d.calls, "call")}`;
          return (
            // The hit target is the full column, taller than the bar.
            <div key={d.day} role="listitem" aria-label={label} title={label} className="group flex h-full min-w-1 flex-1 items-end">
              <div
                className="bg-muted-foreground/70 group-hover:bg-foreground w-full rounded-t-[4px]"
                style={{ height: `${Math.max(2, (totalOf(d) / max) * 100)}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
        <span>{new Date(`${days[0]!.day}T00:00:00`).toLocaleDateString()}</span>
        <span>Peak {compact(max)}</span>
        <span>{new Date(`${days.at(-1)!.day}T00:00:00`).toLocaleDateString()}</span>
      </div>
    </section>
  );
}

interface BreakdownRow {
  key: string;
  name: string;
  detail?: string;
  totals: UsageTotals;
  /** Set when the row is all one billing; a mixed row (a session, an activity) shows both kinds of cost. */
  billing?: "api" | "subscription";
}

function costCell(row: BreakdownRow): string {
  if (row.billing === "subscription") return "ChatGPT plan";
  const t = row.totals;
  const spending = spendingText(t);
  // A mixed row (a session, an activity) may hold plan calls too: name them without adding them to spending.
  const plan = row.billing === undefined && (t.apiEquivalent !== null || t.uncompared > 0);
  if (!plan) return spending;
  return spending === "None" ? "ChatGPT plan" : `${spending} + ChatGPT plan`;
}

function Breakdown({ title, note, rows }: { title: string; note?: string; rows: BreakdownRow[] }) {
  if (rows.length === 0) return null;
  const id = `usage-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="font-heading text-base font-medium">{title}</h3>
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" aria-labelledby={id}>
          <thead className="text-muted-foreground text-left text-xs">
            <tr>
              <th scope="col" className="py-1 pr-2 font-medium">Name</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Tokens</th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">Calls</th>
              <th scope="col" className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t align-top">
                <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                  <span className="block break-words">{row.name}</span>
                  {row.detail && <span className="text-muted-foreground block text-xs">{row.detail}</span>}
                </th>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {tokens(row.totals.total)}
                  {row.totals.unreported > 0 && <span className="text-muted-foreground block text-xs">+{row.totals.unreported} unknown</span>}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{row.totals.calls}</td>
                <td className="py-1.5 text-right text-xs">{costCell(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const RATE_FIELDS = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cached input" },
] as const;

/** Custom prices: optional, for models with no published price (a custom provider's, say) or to override one. */
function Advanced({ prices, onChanged }: { prices: UsageView["prices"]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" className="w-full justify-between">
          Advanced: custom prices
          <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 px-3 pb-3">
        <p className="text-muted-foreground text-sm">
          US dollars per million tokens. A price you set wins over the published one for calls from now on; costs already recorded don't change. No model needs a
          price to work: without one its cost stays unknown.
        </p>
        {prices.length === 0 && <p className="text-muted-foreground text-sm">No models yet.</p>}
        {prices.map((p) => <PriceRow key={p.model} price={p} onChanged={onChanged} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

function PriceRow({ price, onChanged }: { price: UsageView["prices"][number]; onChanged: () => void }) {
  const initial = (key: (typeof RATE_FIELDS)[number]["key"]) => String(price.custom?.[key] ?? "");
  const [values, setValues] = useState(() => Object.fromEntries(RATE_FIELDS.map((f) => [f.key, initial(f.key)])) as Record<string, string>);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const id = `price-${price.model.replace(/[^a-z0-9]/gi, "-")}`;
  const published = price.published ? `Published: ${dollars(price.published.input)} in, ${dollars(price.published.output)} out` : "No published price";

  const save = async (next: ModelPriceInput | null) => {
    setBusy(true);
    setError(undefined);
    const result = await setUsagePrice(price.model, next);
    setBusy(false);
    if (result.ok) onChanged();
    else setError(result.error);
  };
  const submit = () => {
    const input = Number(values.input);
    const output = Number(values.output);
    if (values.input === "" || values.output === "" || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
      setError("Enter input and output prices of 0 or more.");
      return;
    }
    const cached = values.cacheRead === "" ? undefined : Number(values.cacheRead);
    if (cached !== undefined && (!Number.isFinite(cached) || cached < 0)) {
      setError("The cached input price must be 0 or more, or empty.");
      return;
    }
    void save({ input, output, ...(cached !== undefined ? { cacheRead: cached } : {}) });
  };

  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={id} className="text-sm font-medium break-all">{price.label}</span>
        <span className="flex items-center gap-1">
          <Badge variant="secondary">{price.providerLabel}</Badge>
          {price.custom && <Badge>Custom price</Badge>}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {price.billing === "subscription" ? `Billed to your ChatGPT plan; a price here only changes the API comparison. ${published}.` : `${published}.`}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        {RATE_FIELDS.map((f) => (
          <label key={f.key} className="flex w-28 flex-col gap-1 text-xs">
            {f.label}
            <Input
              inputMode="decimal"
              value={values[f.key]}
              disabled={busy}
              aria-label={`${f.label} price for ${price.label}, dollars per million tokens`}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ))}
        <Button type="button" size="sm" disabled={busy} onClick={submit}>Save price</Button>
        {price.custom && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void save(null)}>
            Remove
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    </div>
  );
}

function ClearHistory({ disabled, onCleared }: { disabled: boolean; onCleared: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const clear = async () => {
    setBusy(true);
    setError(undefined);
    const result = await clearUsage();
    setBusy(false);
    if (!result.ok) return setError(result.error);
    setOpen(false);
    onCleared();
  };
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen(true)}>
          Clear usage history
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear usage history?</DialogTitle>
            <DialogDescription>
              This deletes Mivra's usage records. Your conversations, lessons and provider settings are kept. It doesn't reset any provider's billing or your
              plan's limits. Usage starts counting again from the next model call.
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void clear()}>Clear usage history</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
