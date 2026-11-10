import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { getModelTasks, resetModelTask, setModelTask, type ModelSelection, type ModelTaskId, type ModelTaskView } from "./api.js";
import { ModelPicker, modelLabel, useModelPicker, type ModelPickerState } from "./ModelPicker.js";

/** What each overridable task does, as Settings describes it. */
const TASKS: Record<ModelTaskId, { title: string; label: string; description: string }> = {
  lesson: { title: "Lesson generation", label: "Lesson model", description: "Writes each lesson's outline and sections in the background." },
};

/** App-wide settings. Its Models section sets background tasks' models apart from the main one (issue #71). */
export function SettingsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        // The opening button isn't the Sheet's trigger, and on mobile it unmounts with the sidebar.
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = document.querySelector<HTMLElement>("[data-settings-trigger]") ?? document.querySelector<HTMLElement>('[data-sidebar="trigger"]');
          target?.focus();
        }}
      >
        <SheetHeader>
          <SheetTitle className="font-heading">Settings</SheetTitle>
          <SheetDescription>Settings apply from the next reply or lesson; anything already being written keeps its model.</SheetDescription>
        </SheetHeader>
        {open && <ModelsSection />}
      </SheetContent>
    </Sheet>
  );
}

function ModelsSection() {
  const picker = useModelPicker();
  const [tasks, setTasks] = useState<ModelTaskView[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let stale = false;
    void getModelTasks().then((result) => {
      if (stale) return;
      if (result.ok) setTasks(result.value);
      else setError(result.error);
    });
    return () => {
      stale = true;
    };
  }, []);

  const replace = useCallback((task: ModelTaskView) => setTasks((prev) => prev?.map((t) => (t.id === task.id ? task : t))), []);

  return (
    <section aria-labelledby="settings-models" className="flex flex-col gap-4 px-4 pb-4">
      <div className="flex flex-col gap-1">
        <h3 id="settings-models" className="font-heading text-base font-medium">Models</h3>
        <p className="text-muted-foreground text-sm">
          The picker under the message box sets the main model, which chat and new syllabuses always use. A task uses the main model too, and follows it when it
          changes, unless you choose one for it here.
        </p>
      </div>
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
      {!tasks && !error && (
        <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Spinner aria-hidden="true" /> Loading…
        </p>
      )}
      {tasks?.map((task) => <TaskRow key={task.id} task={task} picker={picker} onChange={replace} />)}
    </section>
  );
}

function TaskRow({ task, picker, onChange }: { task: ModelTaskView; picker: ModelPickerState; onChange: (task: ModelTaskView) => void }) {
  const { title, label, description } = TASKS[task.id];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const view = picker.view;
  const name = (selection: ModelSelection) => modelLabel(selection.model, view?.models, view?.providers);

  const save = async (action: () => ReturnType<typeof resetModelTask>) => {
    setBusy(true);
    setError(undefined);
    const result = await action();
    setBusy(false);
    if (result.ok) onChange(result.value);
    else setError(result.error);
  };

  return (
    <div role="group" aria-labelledby={`task-${task.id}`} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={`task-${task.id}`} className="text-sm font-medium">{title}</h4>
        <Badge variant={task.override ? "default" : "secondary"}>{task.override ? "Own model" : "Uses main model"}</Badge>
      </div>
      <p className="text-muted-foreground text-sm">{description}</p>
      {task.override ? (
        <p className="text-sm">Always uses the model below, whatever the main model is.</p>
      ) : (
        <p className="text-sm">
          Follows the main model, now {name(task.effective)}. Choose a model below to use another one for this task.
        </p>
      )}
      {task.unavailable && (
        <Alert variant="destructive">
          <AlertTitle>{name(task.effective)} can't be used for this task</AlertTitle>
          <AlertDescription>
            <p>{task.unavailable}</p>
            <p>Choose another model, or use the main model. Until then, this task fails rather than switching models.</p>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <ModelPicker
          state={picker}
          disabled={busy}
          label={label}
          value={task.effective}
          unavailable={null}
          onChoose={(selection) => void save(() => setModelTask(task.id, selection))}
        />
        {task.override && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void save(() => resetModelTask(task.id))}>
            Use main model
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-sm" role="alert">{error}</p>}
    </div>
  );
}
