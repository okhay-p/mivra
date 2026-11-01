---
status: accepted
date: 30 October 2026
---

# ADR-008: Web UI — shadcn/ui with the Paper & Amber theme

**Context:** The web UI was hand-written CSS. Each new artifact kind would add more one-off styling, and we want a consistent look and accessible components before the end-to-end test is written against the markup.

**Options:** Four themes were prototyped: Ink & Indigo, Teal Lab, Paper & Amber and Grove.

**Decision:** packages/web uses shadcn/ui (Tailwind v4, Radix), with components copied into the repo. Theme: Paper & Amber — warm stone neutrals, amber primary, 12px radius. Fonts: Fraunces for headings, Source Sans 3 for body text, IBM Plex Mono for code and trace values, bundled with the app rather than loaded from a CDN so the app works offline and in Electron. Light/dark follows the OS by default, with a System/Light/Dark switch saved locally. The session list uses shadcn's full Sidebar.

**Consequences:** Adds Tailwind to the web build; copied components are ours to maintain and don't update on their own. Amber is reserved for the brand: wrong answers stay red, correct answers stay green and warnings lean yellow, so grading colours stay distinct. The trace grid stays custom, built with the same theme tokens.
