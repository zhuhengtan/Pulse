import { useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
/** Variable-height windowing. Small histories retain their ordinary DOM and accessibility. */
export function WindowedMessages({ items, container, follow }: {
    items: ReactElement[];
    container: RefObject<HTMLElement | null>;
    follow: RefObject<boolean>;
}) {
    const heights = useRef(new Map<string, number>()), nodes = useRef(new Map<Element, string>());
    const observer = useRef<ResizeObserver | null>(null);
    const [revision, update] = useState(0), [viewport, setViewport] = useState({ top: 0, height: 900 });
    useLayoutEffect(() => {
        const el = container.current;
        if (!el)
            return;
        let frame = 0;
        const sync = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setViewport({ top: el.scrollTop, height: el.clientHeight || 900 })); };
        el.addEventListener('scroll', sync, { passive: true });
        sync();
        if (typeof ResizeObserver !== 'undefined') {
            observer.current = new ResizeObserver(entries => { let changed = false; for (const item of entries) {
                const key = nodes.current.get(item.target);
                if (!key)
                    continue;
                const height = item.target.getBoundingClientRect().height;
                if (height > 0 && Math.abs((heights.current.get(key) ?? 0) - height) > 1) {
                    const previous = heights.current.get(key) ?? 120;
                    if (!follow.current && item.target.getBoundingClientRect().top < el.getBoundingClientRect().top)
                        el.scrollTop += height - previous;
                    heights.current.set(key, height);
                    changed = true;
                }
            } if (changed) {
                update(value => value + 1);
                if (follow.current)
                    el.scrollTop = el.scrollHeight;
            } });
            for (const node of nodes.current.keys())
                observer.current.observe(node);
        }
        return () => { cancelAnimationFrame(frame); el.removeEventListener('scroll', sync); observer.current?.disconnect(); observer.current = null; nodes.current.clear(); };
    }, [container, follow]);
    const offsets = [0];
    for (const item of items)
        offsets.push(offsets.at(-1)! + (heights.current.get(String(item.key)) ?? 120));
    const total = offsets.at(-1) ?? 0, top = follow.current ? Math.max(0, total - viewport.height) : viewport.top;
    let start = 0, end = items.length;
    if (items.length > 120) {
        while (start < items.length && (offsets[start + 1] ?? 0) < top - 1200)
            start++;
        end = start;
        while (end < items.length && (offsets[end] ?? 0) < top + viewport.height + 1200)
            end++;
    }
    useLayoutEffect(() => { if (follow.current && container.current)
        container.current.scrollTop = container.current.scrollHeight; }, [revision, items.length]);
    if (items.length <= 120)
        return <>{items}</>;
    return <><div aria-hidden="true" style={{ height: offsets[start] ?? 0 }}/>{items.slice(start, end).map(item => <div key={item.key} style={{ display: 'flow-root' }} ref={node => { const key = String(item.key); for (const [previous, id] of nodes.current)
        if (id === key && previous !== node) {
            observer.current?.unobserve(previous);
            nodes.current.delete(previous);
        } if (node) {
        nodes.current.set(node, key);
        observer.current?.observe(node);
    } }}>{item}</div>)}<div aria-hidden="true" style={{ height: total - (offsets[end] ?? 0) }}/></>;
}
