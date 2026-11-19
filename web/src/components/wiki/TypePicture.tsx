// A wiki type's picture: an upload (a cover of the project), or the painted stand-in in its family's colour with its
// icon. Entries without a picture of their own show their type's (Builder.tsx Picture).
import type { CSSProperties, ReactNode } from 'react';
import type { EntryType } from '../../../../shared/types';
import { familyOf, paintedBackground, pictureColor, type PictureStyle } from '../../../../shared/wikiFamilies';
import { useStore } from '../../store';

export const coverUrl = (fileId: string) => `/api/covers/${encodeURIComponent(fileId)}`;

/** The background of a type's picture (painted style, or the upload as a cover-sized image). */
export function usePictureStyle(type: EntryType, style?: PictureStyle): CSSProperties {
  const color = useStore((s) => pictureColor(type, familyOf(s.entryTypes, s.entryFamilies, type.id)));
  const pic = type.picture;
  if (!style && pic?.kind === 'file') return { backgroundImage: `url("${coverUrl(pic.fileId)}")` };
  return { background: paintedBackground(style ?? (pic?.kind === 'painted' ? pic.style : 'dusk'), color) };
}

/**
 * The picture as a box: `thumb` (tree rows), `tile` (entry tiles), `big` (the type page). The icon is drawn on painted
 * pictures only; an upload is shown as it is.
 */
export function TypePicture({ type, size, className = '', children }: { type: EntryType; size: 'thumb' | 'tile' | 'big'; className?: string; children?: ReactNode }) {
  const style = usePictureStyle(type);
  const painted = type.picture?.kind !== 'file';
  return (
    <span className={`tp-pic tp-pic-${size} ${className}`.trim()} style={style} aria-hidden={children ? undefined : true}>
      {painted && <span className="tp-pic-ico" aria-hidden>{type.icon ?? '📄'}</span>}
      {children}
    </span>
  );
}
