/** Preserve control state in text observations, including false and zero values. */
export function formatAXNode(node, ref) {
    const role = node.role?.value || '';
    const name = String(node.name?.value ?? '').slice(0, 500);
    const value = node.value?.value;
    const states = (node.properties ?? [])
        .filter(property => ['checked', 'selected', 'expanded', 'disabled', 'pressed', 'required', 'readonly', 'invalid'].includes(property.name))
        .map(property => `${property.name}=${JSON.stringify(property.value?.value)}`);
    return `[${ref}] ${role} ${name}${value !== undefined ? ` value=${String(value).slice(0, 500)}` : ''}${states.length ? ` ${states.join(' ')}` : ''}`;
}
