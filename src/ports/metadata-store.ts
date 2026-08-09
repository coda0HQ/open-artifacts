import type { Publication, PublicationState } from "../publication/model";

export interface PublicationTransition {
  id: string;
  expectedState: PublicationState;
  nextState: PublicationState;
  errorCode?: string | null;
  updatedAt: string;
}

export interface PublicationPage {
  items: Publication[];
  cursor: string | null;
}

export interface MetadataStore {
  createPublication(
    publication: Publication,
  ): Promise<{ publication: Publication; created: boolean }>;
  findPublicationById(id: string): Promise<Publication | null>;
  findPublicationByIdempotency(
    actorScope: string,
    idempotencyKey: string,
  ): Promise<Publication | null>;
  transitionPublication(
    transition: PublicationTransition,
  ): Promise<Publication | null>;
  listPublications(options: {
    state?: PublicationState;
    olderThan?: string;
    limit: number;
    cursor?: string;
  }): Promise<PublicationPage>;
  deletePublication(id: string): Promise<boolean>;
}
