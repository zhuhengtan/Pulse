export interface SlashSuggestion { name: string; description: string }

export function skillSuggestions(names: readonly string[], commands: readonly SlashSuggestion[]): SlashSuggestion[] {
  const reserved = new Set(commands.map(item => item.name.toLowerCase()));
  return names.map(name => ({ name: reserved.has(`/${name}`.toLowerCase()) ? `/skill:${name}` : `/${name}`, description: '技能 · 提交时加载' }));
}

export function searchSlashSuggestions(value: string, items: readonly SlashSuggestion[]): SlashSuggestion[] {
  if (!/^\/\S*$/.test(value)) return [];
  const query = value.slice(1).toLowerCase();
  return items.filter(item => item.name.slice(1).toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.slice(1).toLowerCase().startsWith(query)) - Number(a.name.slice(1).toLowerCase().startsWith(query)) || a.name.localeCompare(b.name));
}
