# Zamex Telematics - Teltonika Listener

Servidor TCP para recibir datos de dispositivos GPS Teltonika y enrutarlos automáticamente a las bases de datos Supabase de cada cliente.

## 🚀 Características

- **Multi-tenant**: Enruta datos automáticamente según configuración en `vista_maestra_dispositivos`
- **Protocolo Completo**: Soporta Codec 8 y Codec 8 Extended
- **Validación de IMEI**: Solo acepta dispositivos registrados en el sistema
- **Cache Inteligente**: Optimiza consultas a la base de datos maestra
- **Logs Detallados**: Monitoreo en tiempo real de conexiones y datos

## 📋 Requisitos

- Node.js 18+
- Acceso a Supabase Zamex (Master DB)
- Servidor con puerto TCP abierto (por defecto: 5027)

## 🛠️ Instalación Local

```bash
cd listener
npm install
cp .env.example .env
# Edita .env con tus credenciales
npm start
```

## 🌐 Despliegue en Railway

1. **Conectar Repositorio:**
   - Ve a [Railway.app](https://railway.app)
   - Crea un nuevo proyecto desde GitHub
   - Selecciona este repositorio

2. **Configurar Variables de Entorno:**
   ```
   PORT=5027
   SUPABASE_URL=https://gamulzbqajseqyglcslf.supabase.co
   SUPABASE_SERVICE_KEY=tu_service_key_aqui
   ```

3. **Configurar el Servicio:**
   - Root Directory: `listener`
   - Start Command: `npm start`
   - Exponer puerto TCP: 5027

4. **Desplegar:**
   - Railway desplegará automáticamente al hacer push a `main`

## 📊 Flujo de Datos

```
Dispositivo GPS → IMEI → Vista Maestra → Validación
                                ↓
                        Credenciales Cliente
                                ↓
                     Parsing Codec 8/8 Ext
                                ↓
                    Supabase Cliente (tabla: telemetria)
                                ↓
                            ACK al GPS
```

## 🔧 Configuración de Dispositivos

En el dispositivo Teltonika (via SMS o Configurator):
```
setparam 2001:<IP_SERVIDOR>
setparam 2002:<PUERTO> (5027)
setparam 2003:0 (Codec 8)
```

## 📄 Estructura de Datos

### Entrada (Codec 8)
Datos binarios del GPS

### Salida (JSON a Supabase Cliente)
```json
{
  "imei": "123456789012345",
  "recorded_at": "2024-02-11T22:00:00.000Z",
  "latitude": 19.432608,
  "longitude": -99.133209,
  "speed": 60,
  "angle": 180,
  "satellites": 12,
  "altitude": 2240,
  "event_id": 0,
  "priority": 0,
  "io_elements": {
    "io_1": 1,
    "io_9": 0,
    "io_66": 13800
  }
}
```

## 🐛 Troubleshooting

**El dispositivo no conecta:**
- Verifica que el puerto TCP esté abierto en el firewall
- Confirma la IP y puerto en el dispositivo
- Revisa los logs del servidor

**Datos no llegan al cliente:**
- Verifica que el IMEI esté registrado en `dispositivos`
- Confirma que el cliente tenga `supabase_url_destino` y `supabase_service_key_destino`
- Revisa que la tabla `telemetria` exista en la base del cliente

**Error de parsing:**
- Verifica que el dispositivo esté configurado con Codec 8
- Revisa los logs para ver el hex dump del paquete

## 📝 Logs

El servidor imprime logs detallados:
- 🔌 Conexiones nuevas
- 📱 Identificación de IMEI
- ✓ Validaciones exitosas
- 📊 Cantidad de registros recibidos
- ❌ Errores de parsing o enrutamiento

## 🔐 Seguridad

- Solo dispositivos registrados pueden conectar
- Service Role Key nunca se expone al cliente
- Credenciales cacheadas temporalmente (5 min)
- Validación estricta de protocolo

## 📞 Soporte

Para problemas o preguntas, contacta al equipo de Zamex Telematics.
