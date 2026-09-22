import hljs from 'highlight.js';
import chalk, { type ChalkInstance } from 'chalk';

const themeColors: Record<string, ChalkInstance> = {
  keyword: chalk.cyan,
  string: chalk.green,
  comment: chalk.gray,
  number: chalk.yellow,
  title: chalk.blue,
  function: chalk.blue,
  built_in: chalk.magenta,
  literal: chalk.yellow,
  meta: chalk.dim,
  type: chalk.blueBright,
  symbol: chalk.magentaBright,
  regexp: chalk.red,
  attr: chalk.cyanBright,
  attribute: chalk.yellowBright,
  addition: chalk.green,
  deletion: chalk.red,
  doctag: chalk.cyan,
  name: chalk.blue,
  selector: chalk.magenta,
  quote: chalk.gray,
  template_variable: chalk.redBright,
  variable: chalk.redBright,
};

export function highlightCode(code: string, language?: string): string {
  let highlighted: string;
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(code, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(code).value;
    }
  } catch {
    return code;
  }

  const result = highlighted
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

  const stack: string[] = [];
  const parts: string[] = [];

  const regex = /(<span class="hljs-[^"]+">|<\/span>)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(result)) !== null) {
    const textBefore = result.substring(lastIndex, match.index);
    if (textBefore) {
      parts.push(applyStackColor(textBefore, stack));
    }

    const tag = match[0];
    if (tag === '</span>') {
      stack.pop();
    } else {
      const clsMatch = /hljs-([^"]+)/.exec(tag);
      if (clsMatch && clsMatch[1]) {
        stack.push(clsMatch[1]);
      }
    }
    lastIndex = regex.lastIndex;
  }

  const textRemaining = result.substring(lastIndex);
  if (textRemaining) {
    parts.push(applyStackColor(textRemaining, stack));
  }

  return parts.join('');
}

function applyStackColor(text: string, stack: string[]): string {
  if (stack.length === 0) return text;
  const cls = stack[stack.length - 1] as string;
  const colorFn = themeColors[cls] || chalk.reset;
  return colorFn(text);
}
