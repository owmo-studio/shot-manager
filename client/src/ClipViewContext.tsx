import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { DesktopAPI } from '../../shared/desktop';

const ClipViewContext = createContext<'import' | 'library'>('import');
export function ClipViewProvider({ mode, children }: { mode: 'import' | 'library'; children: ReactNode }) {
    return <ClipViewContext.Provider value={mode}>{children}</ClipViewContext.Provider>;
}
export function useClipView() {
    const mode = useContext(ClipViewContext);
    const api = useMemo((): DesktopAPI => mode === 'import' ? window.desktop : {
        ...window.desktop,
        getShots: window.desktop.getLibrary,
        onShotsChanged: window.desktop.onLibraryChanged,
        getTagVocabulary: window.desktop.getLibraryVocabulary,
        updateOrganization: window.desktop.updateLibraryOrganization,
        revertOrganization: window.desktop.revertLibraryOrganization,
        reviewIngest: window.desktop.reviewLibraryCommit,
        startIngest: window.desktop.startLibraryCommit,
        getShotThumbnail: window.desktop.getLibraryThumbnail,
        setShotThumbnail: window.desktop.setLibraryThumbnail,
        getShotDetails: window.desktop.getLibraryDetails,
        getShotLut: window.desktop.getLibraryLut,
    }, [mode]);
    return { mode, api, mediaURL: (id: string) => `shot-media://local/${mode === 'library' ? 'library' : 'shots'}/${id}/original` };
}
