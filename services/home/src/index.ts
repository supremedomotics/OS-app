/**
 * @supreme/home — home topology, device registry, and favorites (§4, §11).
 * Owns the Supreme model and binds device capabilities into the SIL registry.
 */
export { HomeService, seedDemoHome } from "./home-service.js";
export { InMemoryHomeStore, type IHomeStore, type StoredDevice } from "./store.js";
