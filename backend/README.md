# Backend (Google Apps Script)

Una Sheet + un Apps Script **por rifa**. El código (`Code.gs`) es el mismo para todas:
lo específico de cada rifa sale de las **Script Properties** y del `config.json` publicado.

## Qué guarda

Pestaña `Numeros` de la Sheet (la crea `initSheet()`):

| numero | estado | nombre | instagram | telefono | reservado_hasta | ref | payment_id | actualizado |
|---|---|---|---|---|---|---|---|---|

- `estado`: `libre` / `reservado` / `vendido` (minúscula, sin tilde).
- `ref`: código único de cada reserva. Es el `external_reference` que viaja a Mercado Pago.
- El GET público (`?action=getNumbers`) devuelve **solo** `numero` y `estado`. Nombres, Instagram y teléfonos no salen de la Sheet.

## Despliegue (5–10 minutos)

1. **Sheet nueva** con el nombre de la rifa. Compartir → *Acceso general: Restringido*.
2. En la Sheet: **Extensiones → Apps Script**. Borrá lo que haya y pegá `backend/Code.gs` completo. Guardá.
3. **Configuración del proyecto (⚙️) → Propiedades del script → Agregar**:

   | Propiedad | Valor |
   |---|---|
   | `MP_ACCESS_TOKEN` | Access Token de Mercado Pago (Tus integraciones → Credenciales). Para probar, el de **prueba**. |
   | `SHEET_ID` | Lo que está entre `/d/` y `/edit` en la URL de la Sheet. |
   | `PAGE_URL` | URL de GitHub Pages, ej. `https://luciaescobedo.github.io/rifa-natura-navidad/` |
   | `RESERVA_MINUTOS` | *(opcional)* default `30`. |
   | `WEBAPP_URL` | *(opcional)* la URL `/exec` del paso 6, para el webhook de MP. Si no está, la toma sola. |

   > El `config.json` ya tiene que estar publicado en `PAGE_URL`: de ahí el backend lee el rango de números y los precios.
   > Así lo que cobra Mercado Pago siempre coincide con lo que muestra la página.

4. En el editor, elegí la función **`initSheet`** → **Ejecutar**. La primera vez te pide permisos (Sheets, conexiones externas, triggers): aceptá.
   Tiene que aparecer en el registro: `Hoja "Numeros" lista: números …`.
5. Elegí **`diagnostico`** → Ejecutar. Tiene que decir `OK` en las tres propiedades, mostrar los precios y tu cuenta de MP.
6. **Implementar → Nueva implementación → Tipo: Aplicación web**
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier persona**

   Copiá la URL que termina en `/exec`.
7. Pegá esa URL en `config.json` → `"backendUrl"`, commit y push.
8. Elegí **`instalarTrigger`** → Ejecutar. Crea el trigger que corre `liberarVencidas` cada 5 minutos
   (o a mano: ⏰ Activadores → Agregar → `liberarVencidas`, basado en tiempo, cada 5 minutos).

## Cada vez que cambies `Code.gs`

1. Guardá.
2. **Implementar → Nueva implementación** (nueva URL `/exec`).
3. Actualizá `backendUrl` en `config.json` (y `WEBAPP_URL` si la cargaste).
4. Corré `initSheet()` de nuevo (no borra nada, solo completa lo que falte).

> Si cambiás precios o el rango de números en `config.json`, el backend lo toma solo en ≤10 minutos (cache).
> Para que sea inmediato, corré `diagnostico()`, que relee el config.

## Cómo valida los pagos

1. `reserve` → marca los números `reservado` por 30 min con una `ref` nueva.
2. `createPreference` → arma la preferencia de MP con el precio **calculado en el backend**, `external_reference = ref`,
   URLs de retorno a `PAGE_URL` y vencimiento igual al de la reserva.
3. Al volver de MP (`confirm`) o cuando llega el **webhook**, el backend consulta `GET /v1/payments/{id}` con el Access Token y
   solo marca `vendido` si: `status = approved`, el `external_reference` coincide con filas de la Sheet, y el monto pagado
   es ≥ al precio de esos números. Es idempotente: si llegan retorno y webhook, no pasa nada raro.
4. Si el pago vuelve rechazado, los números se liberan al toque. Si nadie paga, el trigger los libera a los 30 min.

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| La grilla dice "Error al cargar" | `backendUrl` mal copiado, o la implementación no es "Cualquier persona". |
| `No existe la pestaña. Corré initSheet().` | No corriste `initSheet()` o cambiaste `SHEET_NAME`. |
| `No pude leer …/config.json (404)` | `PAGE_URL` mal, o GitHub Pages todavía no publicó. |
| Pagué y el número sigue 🧡 | Mirá **Ejecuciones** en Apps Script: el log dice por qué no se validó (monto, ref, estado). |
| Los cambios de `Code.gs` no se ven | Falta hacer una **nueva** implementación. |
