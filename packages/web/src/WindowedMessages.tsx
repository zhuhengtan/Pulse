import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
const WINDOWING_THRESHOLD = 120;
/** Variable-height windowing. Short conversations retain their ordinary DOM. */
export function WindowedMessages({ items, container, follow }: {
    items: ReactElement[];
    container: RefObject<HTMLElement | null>;
    follow: RefObject<boolean>;
}) {
    const heights = useRef(new Map<string, number>()), nodes = useRef(new Map<Element, string>());
    const observer = useRef<ResizeObserver | null>(null);
    const pendingAnchor = useRef<{ pinned: boolean; top: number } | undefined>(undefined);
    const [revision, update] = useState(0), [viewport, setViewport] = useState({ top: 0, height: 900 });
    // The parent's element ref is attached after child layout effects run.
    // Install listeners after that ref exists, including on the first mount.
    useEffect(() => {
        const el = container.current;
        if (!el)
            return;
        let frame = 0;
        const sync = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setViewport({ top: el.scrollTop, height: el.clientHeight || 900 })); };
        el.addEventListener('scroll', sync, { passive: true });
        sync();
        if (typeof ResizeObserver !== 'undefined') {
            observer.current = new ResizeObserver(entries => {
                let changed = false, adjustment = 0;
                const pinned = follow.current, viewportTop = el.getBoundingClientRect().top;
                for (const item of entries) {
                const key = nodes.current.get(item.target);
                if (!key)
                    continue;
                const rect = item.target.getBoundingClientRect(), height = item.borderBoxSize?.[0]?.blockSize ?? rect.height;
                if (height > 0 && Math.abs((heights.current.get(key) ?? 0) - height) > 1) {
                    const previous = heights.current.get(key) ?? 120;
                    if (!pinned && rect.top < viewportTop)
                        adjustment += height - previous;
                    heights.current.set(key, height);
                    changed = true;
                }
            } if (changed) {
                // Apply the corrected spacer heights before restoring the anchor.
                // Writing scrollTop against the old DOM can drop bottom-following
                // during a route switch and forces layout once per measured row.
                pendingAnchor.current = { pinned, top: el.scrollTop + adjustment };
                update(value => value + 1);
            } });
            for (const node of nodes.current.keys())
                observer.current.observe(node);
        }
        return () => { cancelAnimationFrame(frame); el.removeEventListener('scroll', sync); observer.current?.disconnect(); observer.current = null; nodes.current.clear(); };
    }, [container, follow]);
    const offsets = [0];
    for (const item of items)
        offsets.push(offsets.at(-1)! + (heights.current.get(String(item.key)) ?? 120));
    const total = offsets.at(-1) ?? 0, top = (pendingAnchor.current?.pinned ?? follow.current) ? Math.max(0, total - viewport.height) : viewport.top;
    let start = 0, end = items.length;
    if (items.length > WINDOWING_THRESHOLD) {
        while (start < items.length && (offsets[start + 1] ?? 0) < top - 1200)
            start++;
        end = start;
        while (end < items.length && (offsets[end] ?? 0) < top + viewport.height + 1200)
            end++;
    }
    useLayoutEffect(() => {
        const anchor = pendingAnchor.current; pendingAnchor.current = undefined;
        const el = container.current;
        if (!el) return;
        if (anchor?.pinned) follow.current = true;
        if (follow.current) el.scrollTop = el.scrollHeight;
        else if (anchor) el.scrollTop = anchor.top;
    }, [revision, items.length]);
    if (items.length <= WINDOWING_THRESHOLD)
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
