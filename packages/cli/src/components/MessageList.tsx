import type { DisplayMessage, Verbosity } from '../types.js';
import { MessageViewport } from './MessageViewport.js';

interface Props {
  mouseEnabled?: boolean;
  messages: DisplayMessage[];
  showThinking?: boolean | undefined;
  verbosity?: Verbosity | undefined;
  isRunning?: boolean | undefined;
}

export function MessageList({ mouseEnabled = true, messages, showThinking, verbosity = 'normal', isRunning = false }: Props) {
  return <MessageViewport mouseEnabled={mouseEnabled} messages={messages} {...(showThinking === undefined ? {} : { showThinking })} verbosity={verbosity} isRunning={isRunning} />;
}
