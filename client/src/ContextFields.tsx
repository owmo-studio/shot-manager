export function ContextFields({ empty = false }: { empty?: boolean }) {
    return <fieldset disabled className="space-y-4 text-xs text-zinc-500">
        <label className="block">Identity
            <select defaultValue="" className="mt-1.5 block w-full rounded-md border border-white/10 bg-transparent px-3 py-2">
                <option value="">{empty ? "" : "Not assigned"}</option><option>OWMO</option><option>CMSH</option>
            </select>
        </label>
        <label className="block">Project
            <input placeholder={empty ? "" : "Optional project"} className="mt-1.5 block w-full rounded-md border border-white/10 bg-transparent px-3 py-2" />
        </label>
        <label className="block">Tags
            <input placeholder={empty ? "" : "Add tags…"} className="mt-1.5 block w-full rounded-md border border-white/10 bg-transparent px-3 py-2" />
        </label>
        <label className="block">Notes
            <textarea rows={4} placeholder={empty ? "" : "Optional notes"} className="mt-1.5 block w-full resize-none rounded-md border border-white/10 bg-transparent px-3 py-2" />
        </label>
    </fieldset>;
}
