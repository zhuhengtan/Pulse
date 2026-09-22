import { useState, useCallback } from 'react';

export function useMultilineInput() {
  const [currentLine, setCurrentLine] = useState('');
  const [accumulatedLines, setAccumulatedLines] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const isContinuation = currentLine.endsWith('\\');

  const handleSubmit = useCallback((line: string): string | null => {
    const trimmedLine = line.trimEnd();

    // 如果以反斜杠结尾，视为多行输入的续行
    if (trimmedLine.endsWith('\\')) {
      const newLine = trimmedLine.slice(0, -1);
      setAccumulatedLines(prev => [...prev, newLine]);
      setCurrentLine('');
      return null;
    }

    // 否则结束多行输入
    const finalLines = [...accumulatedLines, line];
    const fullText = finalLines.join('\n');

    setAccumulatedLines([]);
    setCurrentLine('');

    return fullText;
  }, [accumulatedLines]);

  const addToHistory = useCallback((text: string) => {
    if (!text.trim()) return;
    setHistory(prev => {
      // 保持最多 50 条历史记录
      const next = [text, ...prev.filter(h => h !== text)].slice(0, 50);
      return next;
    });
    setHistoryIndex(-1);
  }, []);

  const navigateHistory = useCallback((direction: 'up' | 'down'): string | undefined => {
    if (history.length === 0) return undefined;

    let nextIndex = historyIndex;
    if (direction === 'up') {
      nextIndex = Math.min(historyIndex + 1, history.length - 1);
    } else {
      nextIndex = Math.max(historyIndex - 1, -1);
    }

    setHistoryIndex(nextIndex);
    return nextIndex === -1 ? '' : history[nextIndex];
  }, [history, historyIndex]);

  return {
    currentLine,
    setCurrentLine,
    accumulatedLines,
    isContinuation,
    handleSubmit,
    history,
    historyIndex,
    navigateHistory,
    addToHistory
  };
}
