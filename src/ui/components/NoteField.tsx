import { useRef, useState } from 'react';
import { send } from '@/lib/messages';
import { FOLDER_NOTE_MAX, type FolderRecord } from '@/lib/types';
import { cx } from '../cx';
import { commandProblem } from '../openTabs';
import { toast } from './Toast';

/**
 * A folder's star and one-line note (1.0, Fi-Fold-States): ⋯ › Star / Unstar, Add a note / Edit the
 * note. The note shows under the folder's name; click it to edit in place (140 characters, Enter
 * saves, Esc cancels, empty removes it).
 */

/** One line, squeezed, at most 140 characters (never cut mid-character). */
export function cleanNote(text: string): string {
  return [...text.replace(/\s+/g, ' ').trim()].slice(0, FOLDER_NOTE_MAX).join('');
}

export async function starFolder(folder: FolderRecord, starred: boolean): Promise<void> {
  try {
    await send({ type: 'folder-update', id: folder.id, starred });
  } catch (error) {
    toast(commandProblem(error, starred ? 'Couldn’t star the folder.' : 'Couldn’t unstar the folder.'), { tone: 'error' });
  }
}

export async function saveNote(folder: FolderRecord, note: string): Promise<void> {
  const clean = cleanNote(note);
  if (clean === (folder.note ?? '')) return;
  try {
    await send({ type: 'folder-update', id: folder.id, note: clean });
  } catch (error) {
    toast(commandProblem(error, 'Couldn’t save the note.'), { tone: 'error' });
  }
}

/** The note field with its "32 / 140" counter and hint. */
export function NoteField({ folder, onDone, className }: { folder: FolderRecord; onDone: () => void; className?: string }) {
  const [text, setText] = useState(folder.note ?? '');
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) void saveNote(folder, text);
    onDone();
  };
  const length = [...text].length;
  const hintId = `note-hint-${folder.id}`;
  return (
    <div className={className}>
      <div className="flex h-[30px] items-center gap-2 rounded-md border border-accent bg-surface px-2 shadow-[0_0_0_3px_var(--tf-accent-soft)]">
        <input
          autoFocus
          aria-label={`Note for ${folder.name}`}
          aria-describedby={hintId}
          value={text}
          placeholder="A line about this folder"
          onChange={(e) => setText([...e.target.value.replace(/[\r\n]+/g, ' ')].slice(0, FOLDER_NOTE_MAX).join(''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              finish(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            }
          }}
          onBlur={() => finish(true)}
          className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-small text-text outline-none"
        />
        <span aria-hidden className={cx('flex-none text-meta tabular-nums', length >= FOLDER_NOTE_MAX ? 'text-amber' : 'text-text-3')}>
          {length} / {FOLDER_NOTE_MAX}
        </span>
      </div>
      <p id={hintId} className="m-0 mt-1 text-meta text-text-3">
        Enter to save · Esc to cancel · Empty it to remove the note
      </p>
    </div>
  );
}
