/**
 * MediaPipe's canonical face model (Apache-2.0; the same 468 vertices the
 * backend's head3d/canonical_face_mesh.json holds, from face_landmarker.task):
 * x, y, z per landmark in hundredths of a centimetre, y up, z toward the
 * camera. The rig keeps only each landmark's x and y in the photo; its
 * depth comes from this model, fitted to them (head-depth.ts). The ten iris
 * landmarks (468-477) are not in the model.
 *
 * Kept as text, half the bytes of the numbers written out and fewer once
 * compressed, decoded once when the module loads: every x's magnitude, then
 * every y, then every z, each value plus 2048 in two base-64 digits; then
 * the x's signs, six to a digit (the face is symmetric, and its two halves'
 * x's alike compress well). canonical-face.test.ts holds it to the
 * backend's model.
 */
const DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MODEL =
  "gAgAgAgugAgAgAmpgAgAgAgAgAgAgAgAgAgAgAgAgqrFkHlAl6m/jYlBkLl3mgn6jjm9rRpEkchHg9iPi/hxickJgrgyoNisihilndgwl1nL" +
  "p0h6jbk2qgh3hJj2jcnzifkIkUlgowkyo8p9hDh+ithojojOjXhfiThmg1hNhGhDg/g6iaiiiti4jtrygAi3jBg8iNhCjqlNitoBnGmPjZiM" +
  "iii9mko9i6nziCiDqHoOm7lKjzi2g4p6ovgYihsGiLiznTiFrXi6hcn0n9rMpIqtjxgSjSqBlvk+jcpviBlBmXgAgAkQjljIpljlkQk+lvmS" +
  "r0mSgAiyh6hJgAmelLiDpSjIhagAjnq3huh2h+iFibjDjUjlkdoQhfiDiyi5oghNjCgAg0gAh9gAgAhklJjnkMl/kom3h6iamEk0l3phnLqS" +
  "ldh+hxiQhciwkHlTmYnOoFranXmXlHj9jFier+iMhYhNguhLh8gnggikh+hnmpnFgumpgqrFkHlAl6m/jYlBkLl3mgn6jjm9rRpEkchHg9iP" +
  "i/hxickJgrgyoNisihilndgwl1nLp0h6jbk2qgh3hJj2jcnzifkIkUlgowkyo8p9hDh+ithojojOjXhfiThmg1hNhGhDg/g6iaiiiti4jtry" +
  "i3jBg8iNhCjqlNitoBnGmPjZiMiii9mko9i6nziCiDqHoOm7lKjzi2g4p6ovgYihsGiLiznTiFrXi6hcn0n9rMpIqtjxgSjSqBlvk+jcpviB" +
  "lBmXkQjljIpljlkQk+lvmSr0mSiyh6hJmelLiDpSjIhajnq3huh2h+iFibjDjUjlkdoQhfiDiyi5oghNjCg0h9hklJjnkMl/kom3h6iamEk0" +
  "l3phnLqSldh+hxiQhciwkHlTmYnOoFranXmXlHj9jFier+iMhYhNguhLh8gnggikh+hnmpnFarePcvhgfSglj3kCmSnps6aNZ4ZxY6YlYKXn" +
  "WZdqdtofjMjHjMjyjblClBk9kyjBUZkKjijre4azZ4aiaEZzZoYMeTfQmEhheifDe6genDmuqWmek2ZNYhd9dhZOZSngeCnEn+sho8qRmpnf" +
  "aPaFZ1duZPZAZUeYZsZxZxWeXvYRYqY8ZGZAYyYdbJeXdUZIZHc3dVdKg5gKekrtp4n/Xgn1qUs4jgiNjskziOe9hehfhIhWhxiTjnfLlBdu" +
  "gijti5eekKfkbfkDgHWaUyevXzluTGdXfwjgjsjlY0c+ReSrThqPRUjojwj6lUkhkokoklkembj4cEb0eKcClHVEUCSgWSkSh8STR/cMZCY2" +
  "YhYBW6ZeZiZraRcgi/k2keZmZtk+VrhqieitgXTmVFVLXmdjWddmcdb0TxfyWkVXY+a/YnZ2bAhQejeOfLlhlzl0lwlbj+hMiliUiTiii6jS" +
  "hDd6hCefd7eVdhdzdfkAj3jukVkjhgkCdtofjMjHjMjyjblClBk9kyjBUZkKjijre4azZ4aiaEZzZoYMeTfQmEhheifDe6genDmuqWmek2ZN" +
  "Yhd9dhZOZSngeCnEn+sho8qRmpnfaPaFZ1duZPZAZUeYZsZxZxWeXvYRYqY8ZGZAYyYdbJeXZIZHc3dVdKg5gKekrtp4n/Xgn1qUs4jgiNjs" +
  "kziOe9hehfhIhWhxiTjnfLlBdugijti5eekKfkbfkDgHWaUyevXzluTGdXfwjgjsjlY0c+ReSrThjojwj6lUkhkokoklkembj4b0eKcCVEUC" +
  "SgWSkSh8R/cMZCY2YhYBW6ZeZiZraRcgi/k2keZmZtk+VriegXVLXmdjWddmcdb0TxfyWkVXY+a/YnZ2bAhQejeOfLlhlzl0lwlbj+hMiliU" +
  "iTiii6jShDd6hCefd7eVdhdzdfkAj3jukVkjpWrspeqXr3rUpDlIoQobnApKotoKocopowoqn7rHqFgKmBl8ltk8mBmcmZmNl0kWm3k9gHjc" +
  "m7pMogomn3oHnkmjrgrolQnIpFoulhrGnHmViPn/mQmadRo+pHmsmgl3oinsn2l1kQnFkbifo+oen0o2mqnEmUqLnMntoCnzohonohoWnbnh" +
  "nlninncNqUm4nCpLoMpKmtmboPkKlwm/m+oUnsmslSjzmAk0njqCipkplgmDmUmmoti8kNrDnqc3m9nlk0picfl4qbi9hHf5hchImcqRnJic" +
  "lsl6nAimmZkYjBn3mql6lylxjMl6mDmEl0lcedlYpRoJpTpGoMkLlSnWfBl2o/nplpfzoAoHoMoJncm7nInKnAkeoImnmEmpjTnmnEqlpnp4" +
  "o4oGoDnyl8nLmamem8lsnxoIlLl9l1iTkqgHmdoTqOpPq8mxm0mvmYltkLf7k3lcl1mDmMmYcMozpvrEqnqookq4qLmCmknOlMlOqXlIqFgK" +
  "mBl8ltk8mBmcmZmNl0kWm3k9gHjcm7pMogomn3oHnkmjrgrolQnIpFoulhrGnHmViPn/mQmadRo+pHmsmgl3oinsn2l1kQnFkbifo+oen0o2" +
  "mqnEmUqLnMntoCnzohonohoWnbnhnlninncNm4nCpLoMpKmtmboPkKlwm/m+oUnsmslSjzmAk0njqCipkplgmDmUmmoti8kNrDnqc3m9nlk0" +
  "picfl4qbi9hHf5hchImcqRnJiclsl6nAimmZkYjBl6lylxjMl6mDmEl0lcedlYoJpTpGkLlSnWfBl2o/lpfzoAoHoMoJncm7nInKnAkeoImn" +
  "mEmpjTnmnEpno4nyl8nLmamem8lsnxoIlLl9l1iTkqgHmdoTqOpPq8mxm0mvmYltkLf7k3lcl1mDmMmYcMozpvrEqnqookq4qLmCmknOlMlO" +
  "ICA8///////////v/////////5/7+9//X5///////DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const CANONICAL_FACE_CM100: readonly number[] = decode(MODEL);

/** x, y, z for each of the 468 landmarks, from the model's text. */
function decode(text: string): number[] {
  const n = 468;
  const digit = (k: number) => DIGITS.indexOf(text[k]);
  const at = (k: number) => digit(2 * k) * 64 + digit(2 * k + 1) - 2048;
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    out.push((digit(6 * n + ((i / 6) | 0)) >> (i % 6)) & 1 ? -at(i) : at(i), at(n + i), at(2 * n + i));
  return out;
}
