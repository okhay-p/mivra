import { expect, test } from "../fixtures.js";

// The server checks the milestone's Python reference in Pyodide, which is slow to start on a busy machine.
test.describe.configure({ timeout: 180_000 });

test("a project course plans milestones, shows how to check one, and updates when mivra check reports", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Learning goal" }).fill(`A word counter projectcourse ${Date.now()}`);
  await page.getByRole("checkbox", { name: "Build it as a project in my own repository" }).check();
  await page.getByRole("button", { name: "Start" }).click();

  const course = page.getByRole("region", { name: "Course" });
  await expect(page.getByText("Your project plan is ready.")).toBeVisible();
  await expect(course.getByText("Project", { exact: true })).toBeVisible();
  await expect(course.getByRole("button", { name: /Syllabus · 2 milestones/ })).toBeVisible();

  await course.getByRole("button", { name: "Start lesson 1" }).click();
  const lesson = page.getByRole("article", { name: "Count the words" });
  const milestone = lesson.getByRole("region", { name: "Print the word count" });
  await expect(milestone).toBeVisible({ timeout: 120_000 });
  // The expected outputs come from the reference, which never reaches the page.
  await expect(milestone.getByTestId("milestone-case").first()).toContainText("words: 2");
  await expect(milestone.getByTestId("milestone-case").nth(1)).toContainText("words: 0");
  expect(await page.content()).not.toContain("sys.stdin");
  await expect(milestone).toContainText("Not checked yet.");
  await expect(milestone).toContainText(/mivra link \S+ --run "\.\/your-program \{input\}"/);
  await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeDisabled();

  // `mivra check` reports through the API; the open page shows the result without a reload.
  const { artifactId, courseId } = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>('meta[name="mivra-token"]')!.content;
    const sessions = (await (await fetch("/api/sessions", { headers: { authorization: `Bearer ${token}` } })).json()) as { courseId: string | null }[];
    for (const { courseId } of sessions) {
      if (!courseId) continue;
      const res = await fetch(`/api/courses/${courseId}/milestone`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        const found = (await res.json()) as { artifactId: string; title: string };
        if (found.title === "Print the word count") return { artifactId: found.artifactId, courseId };
      }
    }
    throw new Error("No milestone");
  });
  await expect(milestone).toContainText(`mivra link ${courseId}`);
  const status = await page.evaluate(async (id) => {
    const token = document.querySelector<HTMLMetaElement>('meta[name="mivra-token"]')!.content;
    const res = await fetch(`/api/artifacts/${id}/checks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ results: [{ stdout: "words: 2\n", exitCode: 0 }, { stdout: "words: 1", exitCode: 0 }] }),
    });
    return res.status;
  }, artifactId);
  expect(status).toBe(201);
  await expect(milestone.getByTestId("milestone-status")).toContainText("Latest check: 1 of 2 cases passed");
  await expect(milestone.getByTestId("milestone-case").nth(1)).toHaveAttribute("data-result", "failed");
  await expect(milestone.getByTestId("milestone-case").nth(1)).toContainText("words: 1");
  // Checked once, so the lesson can be finished even though a case fails (ADR-011: scores never block).
  await expect(lesson.getByRole("button", { name: "Finish lesson" })).toBeEnabled();
  await expect(milestone.getByTestId("milestone-review-missing")).toContainText("once every case passes");

  // Every case passes with canned answers: the review, a model's verdict shown as one, doesn't approve.
  const post = (files: { path: string; content: string }[]) =>
    page.evaluate(
      async ({ id, files }) => {
        const token = document.querySelector<HTMLMetaElement>('meta[name="mivra-token"]')!.content;
        const res = await fetch(`/api/artifacts/${id}/checks`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ results: [{ stdout: "words: 2", exitCode: 0 }, { stdout: "words: 0", exitCode: 0 }], files, source: "git" }),
        });
        return res.status;
      },
      { id: artifactId, files },
    );
  expect(await post([{ path: "main.py", content: "# hardcoded\nimport sys\nprint('words: 2' if sys.stdin.read() else 'words: 0')\n" }])).toBe(201);
  const review = milestone.getByTestId("milestone-review");
  await expect(review).toHaveAttribute("data-approved", "false");
  await expect(review).toContainText("Judged by a model");
  await expect(milestone.getByTestId("milestone-status")).toContainText("Not yet.");
  await expect(milestone).toContainText("Sent for review: main.py");

  // The learner disputes the verdict; the tutor looks again (here, it doesn't change its mind).
  await milestone.getByRole("button", { name: "Dispute this verdict" }).click();
  await milestone.getByLabel("Why is the verdict wrong?").fill("It reads the input.");
  await milestone.getByRole("button", { name: "Send dispute" }).click();
  await expect(milestone.getByTestId("milestone-disputes")).toContainText("Review verdict: upheld");

  // A real solution passes the tests and the review.
  expect(await post([{ path: "main.py", content: "import sys\nprint(f'words: {len(sys.stdin.read().split())}')\n" }])).toBe(201);
  await expect(milestone.getByTestId("milestone-status")).toContainText("Milestone passed.");
  await expect(milestone.getByTestId("milestone-review")).toHaveAttribute("data-approved", "true");
});
