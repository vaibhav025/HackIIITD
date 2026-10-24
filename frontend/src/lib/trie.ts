/**
 * Prefix trie for client-side product search.
 *
 * Every node keeps the ids of all words passing through it, so a prefix lookup is O(L) in the
 * prefix length (walk L nodes, return that node's set) regardless of catalogue size.
 */

// Built at runtime so TypeScript's ES2017 target doesn't reject the Unicode property escapes.
const SEPARATOR = new RegExp("[^\\p{L}\\p{N}]+", "u");
const WORD = new RegExp("[\\p{L}\\p{N}]+", "gu");
const MARKS = new RegExp("\\p{M}+", "gu");

/** Case-folded, accent-stripped, NFKC-compatible form: "Café" → "cafe", "ｍｉｌｋ" → "milk". */
export function normalize(text: string): string {
  return text.normalize("NFKD").replace(MARKS, "").toLowerCase().normalize("NFKC");
}

/** Splits on whitespace and punctuation: "Amul Butter-500g" → ["amul", "butter", "500g"]. */
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return normalize(text).split(SEPARATOR).filter(Boolean);
}

interface TrieNode<Id> {
  children: Map<string, TrieNode<Id>>;
  /** Ids with a word that has this node's path as a prefix (includes `exact`). */
  prefix: Set<Id>;
  /** Ids with a word that ends exactly here. */
  exact: Set<Id>;
}

function node<Id>(): TrieNode<Id> {
  return { children: new Map(), prefix: new Set(), exact: new Set() };
}

export class Trie<Id = string> {
  private root: TrieNode<Id> = node();
  /** First-insertion order, used as the final ranking tiebreak. */
  private order = new Map<Id, number>();

  /** Indexes one already-normalized word (use `tokenize` first) for `id`. */
  insert(word: string, id: Id): void {
    if (!this.order.has(id)) this.order.set(id, this.order.size);
    if (!word) return;
    let cur = this.root;
    for (const ch of word) {
      let next = cur.children.get(ch);
      if (!next) cur.children.set(ch, (next = node()));
      next.prefix.add(id);
      cur = next;
    }
    cur.exact.add(id);
  }

  /** Tokenizes `text` and indexes every token for `id`. */
  insertText(text: string | null | undefined, id: Id): void {
    if (!this.order.has(id)) this.order.set(id, this.order.size);
    for (const t of tokenize(text)) this.insert(t, id);
  }

  private find(prefix: string): TrieNode<Id> | undefined {
    let cur: TrieNode<Id> | undefined = this.root;
    for (const ch of prefix) {
      cur = cur.children.get(ch);
      if (!cur) return undefined;
    }
    return cur;
  }

  /** Ids with any word starting with `prefix` (normalized here), in insertion order. */
  searchPrefix(prefix: string): Id[] {
    const p = normalize(prefix);
    if (!p) return [];
    return this.sorted(this.find(p)?.prefix ?? new Set());
  }

  /**
   * Multi-token search: "amul but" → ids where some word starts with "amul" AND some word starts
   * with "but". Ranked by exact-word hits, then (with `mode: "any"`) by matched-token count, then
   * insertion order. An empty query returns [].
   */
  search(query: string, { mode = "all", limit }: { mode?: "all" | "any"; limit?: number } = {}): Id[] {
    const tokens = [...new Set(tokenize(query))];
    if (!tokens.length) return [];
    const matched = new Map<Id, number>();
    const exact = new Map<Id, number>();
    for (const t of tokens) {
      const n = this.find(t);
      if (!n) {
        if (mode === "all") return [];
        continue;
      }
      for (const id of n.prefix) matched.set(id, (matched.get(id) ?? 0) + 1);
      for (const id of n.exact) exact.set(id, (exact.get(id) ?? 0) + 1);
    }
    let ids = [...matched.keys()];
    if (mode === "all") ids = ids.filter((id) => matched.get(id) === tokens.length);
    ids.sort(
      (a, b) =>
        (exact.get(b) ?? 0) - (exact.get(a) ?? 0) ||
        (matched.get(b) ?? 0) - (matched.get(a) ?? 0) ||
        (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0),
    );
    return limit != null ? ids.slice(0, limit) : ids;
  }

  private sorted(ids: Set<Id>): Id[] {
    return [...ids].sort((a, b) => (this.order.get(a) ?? 0) - (this.order.get(b) ?? 0));
  }
}

/** Searchable product fields: name, brand and the marketplace search query. */
export interface Searchable {
  id: string;
  name: string;
  brand?: string | null;
  search_query?: string | null;
}

/** Builds a trie over each product's name, brand and search_query tokens. Wrap in useMemo. */
export function buildProductTrie<P extends Searchable>(products: readonly P[]): Trie<string> {
  const trie = new Trie<string>();
  for (const p of products) {
    trie.insertText(p.name, p.id);
    trie.insertText(p.brand, p.id);
    trie.insertText(p.search_query, p.id);
  }
  return trie;
}

/**
 * Splits `text` into plain/highlighted segments, marking the start of each word that begins with
 * one of the query's tokens: highlight("Amul Butter 500g", "amul but") →
 * [{"Amul", true}, {" ", false}, {"But", true}, {"ter 500g", false}].
 */
export function highlight(text: string, query: string): { text: string; match: boolean }[] {
  const tokens = tokenize(query);
  if (!tokens.length || !text) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  let last = 0;
  const push = (s: string, match: boolean) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev && prev.match === match) prev.text += s;
    else out.push({ text: s, match });
  };
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    const start = m.index ?? 0;
    const norm = normalize(word);
    const best = tokens.filter((t) => norm.startsWith(t)).reduce((a, t) => Math.max(a, t.length), 0);
    if (!best) continue;
    // Smallest original prefix whose normalized form covers the matched token.
    let len = 0;
    for (const ch of word) {
      len += ch.length;
      if (normalize(word.slice(0, len)).length >= best) break;
    }
    push(text.slice(last, start), false);
    push(word.slice(0, len), true);
    last = start + len;
  }
  push(text.slice(last), false);
  return out;
}
