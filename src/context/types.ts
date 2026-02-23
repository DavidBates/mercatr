import type { SimilarArtist } from '../lastfm/types.js';

export type QueryType = 'explore' | 'bridge' | 'theme';

export interface ExploreQuery {
  type: 'explore';
  artist: string;
  track?: string;
}

export interface BridgeQuery {
  type: 'bridge';
  fromArtist: string;
  toArtist: string;
}

export interface ThemeQuery {
  type: 'theme';
  theme: string;
  seedArtists?: string[];
  translatedTags?: string[];
  translateMetadata?: {
    moodTerms: string[];
    genreHints: string[];
  };
}

export type Query = ExploreQuery | BridgeQuery | ThemeQuery;

export interface BuiltContext {
  queryType: QueryType;
  query: Query;
  contextText: string;
  summary: string;
  translationResultCount?: number;
  similarArtists?: SimilarArtist[];
}
