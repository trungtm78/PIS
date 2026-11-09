declare module 'js-yaml' {
  /** The one function the workflow test reads; the package ships no types. */
  export function load(input: string): unknown;
}
