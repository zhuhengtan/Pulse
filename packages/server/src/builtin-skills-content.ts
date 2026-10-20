/**
 * Skill text compiled into Pulse. Kept as plain data so it ships inside the
 * server bundle and needs no external skills directory at runtime.
 */
export interface BuiltinSkillContent {
  name: string
  title: string
  description: string
  content: string
}

export const builtinSkillContents: readonly BuiltinSkillContent[] = [
  {
    name: 'grill-and-plan',
    title: 'Grill and plan',
    description: 'Interview one question per turn, then write and confirm a plan under docs/plans.',
    content: [
      '# Grill and Plan',
      '',
      'Turn a rough request into an agreed, written plan before implementing anything.',
      '',
      '1. Inspect the project first: git status --short, layout, existing docs, and any requirement or plan documents.',
      '2. Interview one question at a time. Give every decision a stable decisionId and decisionScope; mark critical constraints with decisionPriority:"constraint" and stage-specific choices with decisionPriority:"stage"; reuse the same ID after paraphrasing, compaction or restore, and do not rename a resolved facet to ask it again. Choose the tool per question: use the CLI-native ask.input for open questions that need free-form text (goal, scope, trade-offs, constraints) and ask.choice for closed or single-choice questions. Ask exactly ONE plan-changing question per turn, never batch questions, never ask in plain text, and read the documents first so you never ask for information already given. Complete all reading tools in one model turn, then call ask.input or ask.choice alone in the next model turn: never mix an ask interaction with any other tool in the same response, or the runtime rejects the turn with ASK_MIXED_TOOL_CALLS.',
      'Ask presentation: prompt contains only the question; context contains separate background. Give each option a short label (title) and a description explaining its consequence. When a recommendation is justified, put that option first and append “（推荐）” to its label (or “ (Recommended)” in English); explain the reason in description, never repeat the options in prompt. Do not add a blank or Other option: the interface provides a textarea and may return a free-form text answer. Keep the fixed hold/execute confirmation labels in step 7 unchanged.',
      '3. Keep asking one question per turn until goal, scope, trade-offs and acceptance criteria are clear; do not continue while a plan-changing ambiguity remains.',
      '4. Default target is docs/plans/<topic>.md. Writable planning sessions prepare this directory before inspection. In a legacy or read-only session, ENOENT means the plan catalog is absent: do not repeatedly list or read it; plan.write creates the directory automatically when an authorized plan is saved. If that file already exists, use ask.choice to choose another name. If the user forbids overwriting, never offer overwrite as an option. Keep each question tied to an unresolved decision and do not ask again about facts already confirmed. The Runtime supplies a durable Confirmed interaction data bounded registry with chosen label/value, answer excerpts and exact resultRef; task.decisions pages the full index and task.evidence retrieves the original reply: reuse it after compaction or restoration. This registry takes precedence over an older requirement document saying unresolved. Reopen only when the user changes the decision.',
      '5. Write the whole plan to that path in ONE plan.write call, then show the complete plan in chat for the user to review. Use plan.write, never fs.write or fs.stage, for a plan: it writes the entire docs/plans/<topic>.md file in one call even when it is larger than 2048 UTF-8 bytes, creates the parent directory automatically, and never overwrites an existing plan. If the target already exists, ask with ask.choice for another name first as in step 4. After the write, read the file back and preview the complete plan.',
      '6. After EVERY plan revision, check the ENTIRE saved plan again, not only the sections named in feedback. The Host attaches a hash-bound planReview to saved-plan receipts; plan.review re-reads and reviews a saved file when a review is missing or stale. Only status=ready for this exact path/hash permits an execution question. Check step/precondition dependencies as one graph (including external handoffs), unresolved prerequisites and actual authorized mechanisms, state visibility versus pending/disabled behavior, confirmed scope and environment evidence, validation and rollback. Fix contradictions and cycles before asking. A real missing mechanism is a blocker: preserve and present the blocked plan and explain the specific owner/action required; do not invent authorization paths, repeatedly rewrite prose, or ask for implementation while a prerequisite remains unsatisfied. A plan review is not execution approval.',
      '7. Only after the whole-plan review passes, call ask.choice with exactly [{label:"暂不执行",value:"hold"},{label:"执行",value:"execute"}], in that order, alone. Keep these labels and values stable. 暂不执行 is the safe default: pressing Enter keeps it, stops here, halts implementation only, and keeps the already-written plan file unchanged. Implementation starts only when the user deliberately moves the selection to 执行 and confirms.',
      '8. Never implement before the user explicitly selects 执行: do not create or edit any source file such as src/ before confirmation, and never claim a skill or tool ran unless it truly ran.',
    ].join('\n'),
  },
]
