# Artifact math input

Math-enabled artifact fields accept formulas only inside single dollars, with the exact
`splitMath` rules shared between protocol validation and the web renderer. Spaces just
inside dollars, a digit after the closing dollar, adjacent dollars, backticks and blank
lines can prevent a formula. Escaped `\$` is a literal dollar, including during validation.

New tool inputs reject every backslash followed by ASCII letters in literal text. There
is no reliable way to distinguish a LaTeX command from a Windows path, source-code escape
or `A\B` set difference, and artifact math mode has no code-span escape. This deliberate
restriction applies even inside backticks and to doubled backslashes. Use forward-slash
paths, Unicode `∖` for literal set difference, Unicode symbols, or describe code escapes
in words. A backslash followed by punctuation or whitespace remains allowed. Symbols
without commands, such as bare `v_0`, are handled by instructions only.

The input refinement covers all math-mode fields, including deferred check feedback,
set variables, table cell changes, and graph ids used as fallback labels. Concept labels,
trace values/pointers/ranges/variables, graph variables and unrendered ids stay plain.
Stored v1 specs and public views retain their original schemas, so legacy artifacts stay
readable. Validation errors become model-facing tool errors; invalid calls create no
artifact or learner-visible card. The model can correct the call within the turn's
existing five-step budget. Validation does not guarantee a model will choose to retry.
