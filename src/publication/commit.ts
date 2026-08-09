import type { Publication } from "./model";

export type PublicationCommitResult =
  | { committed: true; publication: Publication }
  | {
      committed: false;
      publication: Publication;
      currentVersion: number;
      code: "VERSION_CONFLICT";
    };

export interface PublicationCommitter<TCommitInput> {
  commit(
    publication: Publication,
    input: TCommitInput,
  ): Promise<PublicationCommitResult>;
}
