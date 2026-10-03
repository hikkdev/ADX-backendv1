/**
 * The public address of a landing page — what `GET /p/:slug` answers on.
 * Its own file so the console's reads (`console.service`) and the builder
 * (`landing-page.service`) share it without one importing the other.
 */
export const landingPageUrl = (slug: string): string => `/p/${slug}`;
