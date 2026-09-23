import type { DisplayMessage, Verbosity } from '../types.js';
import { MessageViewport } from './MessageViewport.js';

interface Props {
  messages: DisplayMessage[];
  showThinking?: boolean | undefined;
  verbosity?: Verbosity | undefined;
  isRunning?: boolean | undefined;
}

export function MessageList({ messages, showThinking, verbosity = 'normal', isRunning = false }: Props) {
  return <MessageViewport messages={messages} {...(showThinking === undefined ? {} : { showThinking })} verbosity={verbosity} isRunning={isRunning} />;
}
