import type { DisplayMessage, Verbosity } from '../types.js';
import { MessageViewport } from './MessageViewport.js';

interface Props {
  mouseEnabled?: boolean;
  messages: DisplayMessage[];
  showThinking?: boolean | undefined;
  verbosity?: Verbosity | undefined;
  isRunning?: boolean | undefined;
  onSelectionChange?: ((text: string) => void) | undefined;
}

export function MessageList({ mouseEnabled = true, messages, showThinking, verbosity = 'normal', isRunning = false, onSelectionChange }: Props) {
  return <MessageViewport mouseEnabled={mouseEnabled} messages={messages} {...(showThinking === undefined ? {} : { showThinking })} verbosity={verbosity} isRunning={isRunning} {...(onSelectionChange === undefined ? {} : { onSelectionChange })} />;
}
