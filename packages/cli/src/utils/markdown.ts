import { marked, Token, Tokens } from 'marked';
import chalk from 'chalk';
import { theme } from '../theme.js';
import { highlightCode } from './highlight.js';
import { terminalWidth, horizontalLine, stripTerminalControls } from './ansi.js';

export function renderMarkdownToAnsi(markdown: string): string {
  const tokens = marked.lexer(stripTerminalControls(markdown));
  return renderTokens(tokens).trim();
}

function renderTokens(tokens: Token[]): string {
  return tokens.map(token => renderToken(token)).join('');
}

function renderToken(token: Token): string {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const text = renderTokens(t.tokens);
      const boldText = chalk.bold(text);
      let coloredText = boldText;
      switch (t.depth) {
        case 1: coloredText = chalk.hex(theme.primary)(boldText); break;
        case 2: coloredText = chalk.hex(theme.accent)(boldText); break;
        case 3: coloredText = chalk.hex(theme.user)(boldText); break;
        case 4: coloredText = chalk.hex(theme.tool)(boldText); break;
        default: coloredText = chalk.hex(theme.primary)(boldText); break;
      }
      return `\n${coloredText}\n`;
    }
    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return `${renderTokens(t.tokens)}\n\n`;
    }
    case 'code': {
      const t = token as Tokens.Code;
      const lang = t.lang || '';
      const highlighted = highlightCode(t.text, lang);
      const width = terminalWidth();
      const topBorder = chalk.hex(theme.border)(`╭${'─'.repeat(Math.max(1, width - 2))}╮`);
      const bottomBorder = chalk.hex(theme.border)(`╰${'─'.repeat(Math.max(1, width - 2))}╯`);

      const lines = highlighted.split('\n');
      const content = lines.map(line => `${chalk.hex(theme.border)('│')} ${line}`).join('\n');

      let header = '';
      if (lang) {
        header = chalk.hex(theme.codeLang)(` ${lang} \n`);
      }

      return `\n${topBorder}\n${header}${content}\n${bottomBorder}\n\n`;
    }
    case 'codespan': {
      const t = token as Tokens.Codespan;
      return chalk.hex(theme.accent)(t.text);
    }
    case 'strong': {
      const t = token as Tokens.Strong;
      return chalk.bold(renderTokens(t.tokens));
    }
    case 'em': {
      const t = token as Tokens.Em;
      return chalk.italic(renderTokens(t.tokens));
    }
    case 'del': {
      const t = token as Tokens.Del;
      return chalk.strikethrough(renderTokens(t.tokens));
    }
    case 'list': {
      const t = token as Tokens.List;
      return t.items.map((item, index) => {
        const startNum = typeof t.start === 'number' ? t.start : Number(t.start || 1);
        const prefix = t.ordered ? `${startNum + index}. ` : '• ';
        return `  ${chalk.hex(theme.primary)(prefix)}${renderTokens(item.tokens).trim()}\n`;
      }).join('') + '\n';
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      const text = renderTokens(t.tokens).trim();
      const lines = text.split('\n');
      const quoted = lines.map(line => `${chalk.hex(theme.dim)('│')} ${chalk.hex(theme.dim)(line)}`).join('\n');
      return `\n${quoted}\n\n`;
    }
    case 'hr': {
      return `\n${chalk.hex(theme.border)(horizontalLine())}\n\n`;
    }
    case 'link': {
      const t = token as Tokens.Link;
      const text = renderTokens(t.tokens);
      return chalk.blue.underline(text) + chalk.dim(` (${t.href})`);
    }
    case 'table': {
      const t = token as Tokens.Table;
      let tableOut = '\n';
      const drawRow = (row: Token[][]) => {
        return '| ' + row.map(cell => renderTokens(cell)).join(' | ') + ' |\n';
      };

      tableOut += drawRow(t.header.map(h => h.tokens));
      tableOut += '|' + t.header.map(() => '---').join('|') + '|\n';
      for (const row of t.rows) {
         tableOut += drawRow(row.map(c => c.tokens));
      }
      return tableOut + '\n';
    }
    case 'space': {
      return '';
    }
    case 'text': {
      const t = token as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) {
        return renderTokens(t.tokens);
      }
      return t.text;
    }
    case 'br': {
      return '\n';
    }
    case 'escape': {
      const t = token as Tokens.Escape;
      return t.text;
    }
    case 'image': {
      const t = token as Tokens.Image;
      return chalk.dim(`[图片: ${t.text}]`);
    }
    default: {
      if ('raw' in token) {
        return (token as any).raw;
      }
      return '';
    }
  }
}
