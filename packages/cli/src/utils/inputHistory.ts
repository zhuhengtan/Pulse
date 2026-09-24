export interface InputHistoryState {
  entries: string[]
  position: number | null
  draft: string
}

export const emptyInputHistory = (): InputHistoryState => ({ entries: [], position: null, draft: '' })

export function rememberInput(state: InputHistoryState, value: string): InputHistoryState {
  if (!value.trim()) return { ...state, position: null, draft: '' }
  return { entries: [...state.entries, value].slice(-50), position: null, draft: '' }
}

export function navigateInputHistory(
  state: InputHistoryState,
  direction: 'up' | 'down',
  currentValue: string,
): { state: InputHistoryState; value?: string } {
  if (!state.entries.length) return { state }

  if (direction === 'up') {
    const position = state.position === null
      ? state.entries.length - 1
      : Math.max(0, state.position - 1)
    const draft = state.position === null ? currentValue : state.draft
    return { state: { ...state, position, draft }, value: state.entries[position]! }
  }

  if (state.position === null) return { state }
  if (state.position < state.entries.length - 1) {
    const position = state.position + 1
    return { state: { ...state, position }, value: state.entries[position]! }
  }
  return { state: { ...state, position: null, draft: '' }, value: state.draft }
}
