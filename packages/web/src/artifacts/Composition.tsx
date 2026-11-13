import { compositionChanges, resolveCompositionStep, type CompositionBlock, type CompositionProperty, type ResolvedCompositionEntity, type ResolvedCompositionGroup } from "@mivra/protocol";
import { RotateCcw } from "lucide-react";
import { useId, useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DisplayFormula, MathText } from "../MathText.js";
import type { ArtifactProps } from "./ArtifactPart.js";
import { ArtifactBody, ArtifactCard, ArtifactHeader, ArtifactTitle } from "./artifact-card.js";
import { CodePane } from "./CodePane.js";
import { useCompositionStage } from "./composition-stage.js";
import { ScrollableText, STEP_TONES, StepperControls, useStepper, type StepTone } from "./stepper.js";

/** What a card's tone means, which is otherwise only visible. Neutral needs no words. */
const TONE_WORDS: Record<StepTone, string> = { active: ", current", done: ", done", muted: ", muted" };

/** A property's value as written: literal text, never Markdown or a formula. An empty string still shows. */
const literal = (value: CompositionProperty["value"]) => (value === "" ? '""' : String(value));

/**
 * composition v1 (#109): cards in named groups, the references between them and how both change step by step.
 * Every step is resolved from the declarations alone (`resolveCompositionStep`), so Prev, Restart and the step
 * picker always show what stepping forward showed. The controls sit above the content, so they stay put while the
 * groups below change height. What changed since the step before is written out under the explanation, and said
 * once in a polite live region when the learner changes step, never on first render, a resize or a glide.
 *
 * Over that snapshot (#114), cards glide to their new places when the learner steps to the next or previous step,
 * and lines are drawn for the references wherever they can be routed between the cards without crossing one.
 * Both are only pictures of what the snapshot already says: every reference keeps its chip, the summary is the
 * same with or without motion, and seeking, restarting or reduced motion cut straight to the step.
 */
export function Composition({ view }: ArtifactProps<"composition">) {
  const { spec } = view;
  const stepper = useStepper(spec.steps.length);
  const { index, last, go } = stepper;
  const titleId = useId();
  const kindId = useId();
  const step = resolveCompositionStep(spec, index);
  const changes = compositionChanges(spec, index);
  const grid = useRef<HTMLDivElement>(null);
  const { layout, moving, navigate } = useCompositionStage(grid, index, last, go, step.connections);
  const drawn = new Set(layout.connectors.map((connector) => connector.id));

  // Only a change of step is announced: the region stays empty until the learner first moves.
  const seen = useRef({ index, moved: false });
  if (seen.current.index !== index) seen.current = { index, moved: true };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Home") navigate(0, "seek");
    else if (e.key === "End") navigate(last, "seek");
    else if (e.key === "ArrowLeft") navigate(index - 1, "step");
    else if (e.key === "ArrowRight") navigate(index + 1, "step");
    else return;
    e.preventDefault();
  };

  const changeList = (
    <ul className="flex flex-col gap-0.5">
      {changes.map((change, i) => (
        <li key={i} data-testid="composition-change">
          <ScrollableText>
            <MathText text={change.text} mode="math" />
          </ScrollableText>
        </li>
      ))}
    </ul>
  );

  return (
    <ArtifactCard role="region" aria-labelledby={`${titleId} ${kindId}`} tabIndex={0} onKeyDown={onKeyDown} data-testid="composition">
      <ArtifactHeader kind="Composition" kindId={kindId}>
        <ArtifactTitle id={titleId} text={spec.title} />
      </ArtifactHeader>
      <StepperControls stepper={{ ...stepper, go: (next) => navigate(next, "step") }} placement="header">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
          onClick={() => navigate(0, "seek")}
          aria-disabled={index === 0}
        >
          <RotateCcw />
          Restart
        </Button>
        <select
          aria-label="Go to step"
          className="border-border-strong bg-card focus-visible:ring-ring/50 h-8 max-w-[11rem] min-w-0 truncate rounded-md border px-2 font-mono text-xs outline-none focus-visible:ring-[3px]"
          value={index}
          onChange={(e) => navigate(Number(e.target.value), "seek")}
          // The select's own arrow keys pick an option; they mustn't also step the card.
          onKeyDown={(e) => e.stopPropagation()}
          data-testid="composition-seek"
        >
          {spec.steps.map((s, i) => (
            <option key={i} value={i}>
              {`Step ${i + 1}${s.label ? `: ${s.label}` : ""}`}
            </option>
          ))}
        </select>
      </StepperControls>
      <ArtifactBody>
        <div className="flex min-w-0 flex-col gap-1.5" data-testid="composition-step">
          {step.label && (
            <p className="bg-sunken w-fit max-w-full rounded-md px-2 py-0.5 font-mono text-sm" data-testid="composition-step-label">
              <ScrollableText label="Step label, scrolls sideways">
                <span className="whitespace-pre">{step.label}</span>
              </ScrollableText>
            </p>
          )}
          <p className="leading-normal" data-testid="composition-explanation">
            <ScrollableText>
              <MathText text={step.explanation} mode="math" />
            </ScrollableText>
          </p>
          <div className="text-muted-foreground text-sm" data-testid="composition-changes">
            <p className="font-mono text-[0.6875rem] font-medium tracking-[0.06em] uppercase">{index === 0 ? "At the start" : "What changed"}</p>
            {changes.length ? changeList : <p>Nothing visible changed.</p>}
          </div>
        </div>
        <div className="sr-only" aria-live="polite" aria-atomic="true" data-testid="composition-status">
          {seen.current.moved && (
            <>
              Step {index + 1} of {last + 1}. {step.label && <>{step.label}. </>}
              <MathText text={step.explanation} mode="math" />{" "}
              {changes.map((change, i) => (
                <span key={i}>
                  <MathText text={change.text} mode="math" />{" "}
                </span>
              ))}
            </>
          )}
        </div>
        {/* isolate: the lines sit above the groups' backgrounds and below the cards, which are z-[1]. */}
        <div
          ref={grid}
          className="relative isolate grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,13.75rem),1fr))] items-start gap-3"
          data-testid="composition-groups"
          data-moving={moving || undefined}
          data-narrow={layout.narrow || undefined}
        >
          {step.groups.map((group) => (
            <Group key={group.id} group={group} drawn={drawn} />
          ))}
          {/* A picture of the chips, which screen readers already have. */}
          <svg
            className={cn("pointer-events-none absolute inset-0 z-0 size-full overflow-visible transition-opacity duration-150 motion-reduce:transition-none", moving && "opacity-0")}
            aria-hidden="true"
            fill="none"
            data-testid="composition-connectors"
          >
            {layout.connectors.map((connector) => (
              <g key={connector.id} data-testid="composition-connector" data-connection={connector.id}>
                <path d={connector.path} className="stroke-muted-foreground" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
                <polygon points={connector.arrow} className="fill-muted-foreground" />
              </g>
            ))}
          </svg>
        </div>
      </ArtifactBody>
    </ArtifactCard>
  );
}

function Group({ group, drawn }: { group: ResolvedCompositionGroup; drawn: ReadonlySet<string> }) {
  const headingId = useId();
  const List = group.ordered ? "ol" : "ul";
  return (
    <section className="bg-sunken/55 flex min-w-0 flex-col gap-2 rounded-lg border p-2.5" aria-labelledby={headingId} data-testid="composition-group" data-group={group.id}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2" data-composition-obstacle>
        <h4 id={headingId} className="min-w-0 text-sm font-semibold">
          <ScrollableText>
            <MathText text={group.label} mode="math" />
          </ScrollableText>
        </h4>
        {group.ordered && <span className="text-muted-foreground font-mono text-[0.6875rem]">first at top</span>}
      </div>
      {group.entities.length ? (
        <List className="flex min-w-0 flex-col gap-2">
          {group.entities.map((entity) => (
            <Entity key={entity.id} entity={entity} drawn={drawn} />
          ))}
        </List>
      ) : (
        <p className="text-muted-foreground rounded-md border border-dashed px-2 py-2 text-center text-xs" data-testid="composition-empty" data-composition-obstacle>
          Empty
        </p>
      )}
    </section>
  );
}

function Entity({ entity, drawn }: { entity: ResolvedCompositionEntity; drawn: ReadonlySet<string> }) {
  return (
    <li
      className={cn("bg-card border-border-strong relative z-[1] flex min-w-0 flex-col gap-1.5 rounded-md border px-2.5 py-2", entity.tone && STEP_TONES[entity.tone])}
      data-testid="composition-entity"
      data-entity={entity.id}
      data-tone={entity.tone}
    >
      <p className="min-w-0 font-medium">
        <ScrollableText>
          <MathText text={entity.label} mode="math" />
        </ScrollableText>
        {entity.tone && <span className="sr-only">{TONE_WORDS[entity.tone]}</span>}
      </p>
      {entity.properties.length > 0 && (
        <dl className="grid min-w-0 grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-2 font-mono text-xs" data-testid="composition-properties">
          {entity.properties.map((property) => (
            <div key={property.name} className="contents" data-testid="composition-property">
              <dt className="text-muted-foreground wrap-anywhere">{property.name}</dt>
              <dd className="wrap-anywhere whitespace-pre-wrap">{literal(property.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {entity.body.map((block, i) => (
        <Block key={i} block={block} />
      ))}
      {entity.callout && (
        <p className="bg-sunken border-foreground/40 rounded-sm border-l-2 px-2 py-1 text-sm" data-testid="composition-callout">
          <ScrollableText>
            <span className="sr-only">Note: </span>
            <MathText text={entity.callout} mode="math" />
          </ScrollableText>
        </p>
      )}
      {entity.references.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="References">
          {entity.references.map((reference) => (
            <li
              key={reference.connectionId}
              className="border-border-strong bg-card flex max-w-full min-w-0 items-baseline gap-1 rounded-full border px-2 py-0.5 text-xs"
              data-testid="composition-reference"
              data-connection={reference.connectionId}
              data-to={reference.to}
              data-drawn={drawn.has(reference.connectionId) || undefined}
            >
              <span aria-hidden="true">→</span>
              <span className="sr-only">refers to </span>
              <span className="min-w-0 wrap-anywhere">
                <MathText text={reference.toLabel} mode="math" />
              </span>
              {reference.label && (
                <span className="text-muted-foreground min-w-0 wrap-anywhere">
                  <span aria-hidden="true">· </span>
                  <span className="sr-only">, as </span>
                  <MathText text={reference.label} mode="math" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** A fixed body block: inert code, a short note or a display formula, each bounded to the card. */
function Block({ block }: { block: CompositionBlock }) {
  if (block.type === "code") return <CodePane code={{ language: block.language, source: block.code }} lines={[]} />;
  if (block.type === "math") {
    return (
      <div className="min-w-0 text-sm" data-testid="composition-math">
        <ScrollableText>
          <DisplayFormula source={block.source} />
        </ScrollableText>
      </div>
    );
  }
  return (
    <p className="min-w-0 text-sm leading-snug" data-testid="composition-text">
      <ScrollableText>
        <MathText text={block.text} mode="math" />
      </ScrollableText>
    </p>
  );
}
