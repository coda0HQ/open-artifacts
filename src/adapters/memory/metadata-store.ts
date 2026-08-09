import type {
  MetadataStore,
  PublicationPage,
  PublicationTransition,
} from "../../ports/metadata-store";
import type { Publication } from "../../publication/model";
import { transitionPublication } from "../../publication/model";

const copy = (publication: Publication): Publication => ({ ...publication });

export class MemoryMetadataStore implements MetadataStore {
  readonly #byId = new Map<string, Publication>();
  readonly #idempotency = new Map<string, string>();

  async createPublication(
    publication: Publication,
  ): Promise<{ publication: Publication; created: boolean }> {
    const scopedKey = `${publication.actorScope}\0${publication.idempotencyKey}`;
    const existingId = this.#idempotency.get(scopedKey);
    if (existingId !== undefined) {
      const existing = this.#byId.get(existingId);
      if (existing === undefined) {
        throw new Error("idempotency index references missing publication");
      }
      return { publication: copy(existing), created: false };
    }
    if (this.#byId.has(publication.id)) {
      throw new Error(`publication ID already exists: ${publication.id}`);
    }
    this.#byId.set(publication.id, copy(publication));
    this.#idempotency.set(scopedKey, publication.id);
    return { publication: copy(publication), created: true };
  }

  async findPublicationById(id: string): Promise<Publication | null> {
    const publication = this.#byId.get(id);
    return publication ? copy(publication) : null;
  }

  async findPublicationByIdempotency(
    actorScope: string,
    idempotencyKey: string,
  ): Promise<Publication | null> {
    const id = this.#idempotency.get(`${actorScope}\0${idempotencyKey}`);
    return id ? this.findPublicationById(id) : null;
  }

  async transitionPublication(
    input: PublicationTransition,
  ): Promise<Publication | null> {
    const publication = this.#byId.get(input.id);
    if (!publication || publication.state !== input.expectedState) return null;
    transitionPublication(input.expectedState, input.nextState);
    const updated: Publication = {
      ...publication,
      state: input.nextState,
      errorCode: input.errorCode ?? null,
      updatedAt: input.updatedAt,
    };
    this.#byId.set(input.id, updated);
    return copy(updated);
  }

  async listPublications(options: {
    state?: Publication["state"];
    olderThan?: string;
    limit: number;
    cursor?: string;
  }): Promise<PublicationPage> {
    const matches = [...this.#byId.values()]
      .filter(
        (item) =>
          (options.state === undefined || item.state === options.state) &&
          (options.olderThan === undefined ||
            item.updatedAt < options.olderThan) &&
          (options.cursor === undefined || item.id > options.cursor),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const page = matches.slice(0, options.limit);
    return {
      items: page.map(copy),
      cursor: matches.length > options.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async deletePublication(id: string): Promise<boolean> {
    const publication = this.#byId.get(id);
    if (!publication) return false;
    this.#byId.delete(id);
    this.#idempotency.delete(
      `${publication.actorScope}\0${publication.idempotencyKey}`,
    );
    return true;
  }
}
