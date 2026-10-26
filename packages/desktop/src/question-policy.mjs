import { createHash } from 'node:crypto';
export const questionFingerprint = group => createHash('sha256').update(JSON.stringify(group)).digest('hex');
export function ordinaryQuestion(group) {
    return group?.kind === 'ask' && group.items?.length > 0 && group.items.every(({ input }) => {
        if (!input || !['input', 'choice', 'multi'].includes(input.type)) return false;
        if (input.decisionScope || input.decisionId || input.planPath || input.tools || input.operationCount || input.approved !== undefined) return false;
        const labels = (input.options ?? []).map(option => typeof option === 'string' ? option : option?.label ?? option?.value ?? '');
        return !(labels.length === 2 && /^暂不执行/u.test(labels[0]) && /^执行/u.test(labels[1]));
    });
}
export function choiceActions(group) {
    if (!ordinaryQuestion(group) || group.items.length !== 1 || group.items[0].input.type !== 'choice') return [];
    const { prompt, options } = group.items[0].input;
    if (typeof prompt !== 'string' || !prompt.trim() || [...prompt].length > 140) return [];
    if (!Array.isArray(options) || options.length < 1 || options.length > 3) return [];
    const normalized = options.map(option => typeof option === 'string' ? { value: option, label: option } : { value: option?.value, label: option?.label ?? option?.value, description: option?.description });
    if (normalized.some(option => typeof option.value !== 'string' || !option.value.trim() || typeof option.label !== 'string' || !option.label.trim() || [...option.label].length > 18 || /[\r\n]/.test(option.label) || option.description)) return [];
    if (new Set(normalized.map(option => option.value)).size !== options.length || new Set(normalized.map(option => option.label)).size !== options.length) return [];
    return normalized;
}
export function currentQuestion(item, snapshot) {
    const group = snapshot.state === 'running' && snapshot.interactions?.find(group => group.groupId === item.groupId);
    if (!ordinaryQuestion(group) || !item.group || questionFingerprint(group) !== questionFingerprint(item.group)) throw new Error('QUESTION_EXPIRED');
    return group;
}
export function validQuestionAnswers(group, answers) {
    if (!Array.isArray(answers) || answers.length !== group.items.length || new Set(answers.map(answer => answer?.effectId)).size !== answers.length) return false;
    return group.items.every(item => {
        const answer = answers.find(answer => answer?.effectId === item.effectId)?.value;
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
        const keys = Object.keys(answer), options = (item.input.options ?? []).map(option => typeof option === 'string' ? option : option.value);
        if (keys.length === 1 && keys[0] === 'text') return typeof answer.text === 'string' && Boolean(answer.text.trim()) && answer.text.length <= 4000;
        if (item.input.type === 'choice') return keys.length === 1 && keys[0] === 'value' && options.includes(answer.value);
        if (item.input.type !== 'multi' || keys.length !== 1 || keys[0] !== 'values' || !Array.isArray(answer.values)) return false;
        return new Set(answer.values).size === answer.values.length && answer.values.every(value => options.includes(value)) && answer.values.length >= (item.input.min ?? 0) && answer.values.length <= (item.input.max ?? Infinity);
    });
}
