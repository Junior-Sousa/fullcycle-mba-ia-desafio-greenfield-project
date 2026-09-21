# Guia de Execução e Testes Manuais — StreamTube (Fase 02 & Fase 03)

Este guia prático contém as instruções passo a passo para você **subir a infraestrutura**, **executar o servidor e worker**, e **testar manualmente** todas as funcionalidades da **Fase 02 (Autenticação)** e **Fase 03 (Upload e Processamento de Vídeos)**.

---

## 🛠️ 1. Subindo o Ambiente Local (Docker & Serviços)

### 1.1. Iniciar os Containers Docker
Abra o terminal na pasta `nestjs-project/` e execute:

```bash
cd nestjs-project
docker compose up -d
```

> **Serviços que serão iniciados:**
> - 🗄️ **PostgreSQL 17** (`localhost:5432`)
> - ⚡ **Redis 7** (`localhost:6379`)
> - 📦 **MinIO S3 Storage** (`localhost:9000` API | `localhost:9001` Console Web)
> - 📧 **Mailpit Email Server** (`localhost:1025` SMTP | `localhost:8025` Web UI)

---

### 1.2. Executar as Migrations do Banco de Dados
Para criar as tabelas `users`, `channels`, `verification_tokens`, `refresh_tokens` e `videos`:

```bash
npm run migration:run
```

---

### 1.3. Iniciar a API NestJS
Em um terminal dedicado:

```bash
npm run start:dev
```
*A API estará disponível em `http://localhost:3000` e a documentação Swagger em `http://localhost:3000/api`.*

---

### 1.4. Iniciar o Worker de Vídeo (Processador de Filas)
Em um segundo terminal dedicado:

```bash
npm run start:worker
```
*O Worker se conectará à fila BullMQ Redis e ao MinIO, criando o bucket `streamtube-videos` automaticamente se necessário.*

---

## 🖥️ 2. Painéis Web & Ferramentas Úteis

Ao subir o ambiente, você pode acessar os seguintes painéis no navegador:

| Painel | URL | Credenciais / Acesso |
|--------|-----|----------------------|
| **Swagger OpenAPI Docs** | [http://localhost:3000/api](http://localhost:3000/api) | Interface interativa de endpoints |
| **MinIO Console (S3 Storage)** | [http://localhost:9001](http://localhost:9001) | Usuário: `minioadmin` \| Senha: `minioadmin` |
| **Mailpit (Caixa de E-mails)** | [http://localhost:8025](http://localhost:8025) | Recebe os links e tokens de confirmação |

---

## 🔑 3. Testando as Funcionalidades da Fase 02 (Autenticação)

Você pode rodar os comandos via **Terminal (cURL)** ou utilizar o arquivo [`api.http`](file:///Users/macbookpro/github/fullcycle-mba-ia-desafio-greenfield-project/nestjs-project/api.http) na extensão REST Client do VS Code.

### 3.1. Cadastrar um Novo Usuário

```bash
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "meu_usuario@example.com",
    "password": "Password123!"
  }'
```

### 3.2. Confirmar o E-mail
1. Acesse o Mailpit em [http://localhost:8025](http://localhost:8025).
2. Abra a mensagem recebida e copie o valor do parâmetro `token` na URL do link.
3. Execute o GET de confirmação:

```bash
curl -X GET "http://localhost:3000/auth/confirm-email?token=SEU_TOKEN_COPIADO"
```

### 3.3. Fazer Login e Obter o JWT Access Token

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "meu_usuario@example.com",
    "password": "Password123!"
  }'
```

> 💡 **Guarde o `access_token` retornado** para os passos da Fase 03 abaixo.

---

## 📹 4. Testando as Funcionalidades da Fase 03 (Upload e Processamento)

### 4.1. Gerar um Vídeo de Teste Real (5 segundos)
Execute este comando no terminal para criar um arquivo MP4 de 5s via `ffmpeg-static`:

```bash
node -e "
const { execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
execSync(\`\${ffmpegPath} -y -f lavfi -i testsrc=size=640x360:rate=30 -t 5 sample_test.mp4\`);
console.log('Vídeo sample_test.mp4 gerado!');
"
```

---

### 4.2. Passo 1: Iniciar Upload Multipart (`POST /videos/upload/initiate`)

```bash
TOKEN="SEU_ACCESS_TOKEN_AQUI"
FILE_SIZE=$(wc -c < sample_test.mp4 | tr -d ' ')

curl -X POST http://localhost:3000/videos/upload/initiate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"title\": \"Meu Vídeo de Teste\",
    \"description\": \"Vídeo demonstrativo com thumbnail automática\",
    \"fileName\": \"sample_test.mp4\",
    \"mimeType\": \"video/mp4\",
    \"fileSize\": $FILE_SIZE
  }"
```

**Resposta Exemplo:**
```json
{
  "id": "uuid-do-video",
  "videoId": "ABC123XYZ0",
  "uploadId": "upload-id-s3-...",
  "s3Key": "raw-videos/ABC123XYZ0/sample_test.mp4",
  "parts": [
    {
      "partNumber": 1,
      "url": "http://localhost:9000/streamtube-videos/raw-videos/ABC123XYZ0/sample_test.mp4?X-Amz-Algorithm=..."
    }
  ]
}
```

---

### 4.3. Passo 2: Fazer Upload da Parte Direta ao MinIO S3

Copie a `url` do objeto `parts[0]` retornado e faça o upload direto via HTTP `PUT`:

```bash
curl -i -X PUT "URL_PRESIGNED_DA_PARTE_1" --data-binary "@sample_test.mp4"
```

> ⚠️ **IMPORTANTE:** Copie o cabeçalho `ETag` retornado na resposta do MinIO (exemplo: `ETag: "79f3fdc1072a50919ec69c5b7b6667d0"`).

---

### 4.4. Passo 3: Confirmar Upload (`POST /videos/:videoId/upload/confirm`)

Informe o `videoId`, `uploadId` e o array de partes com o `ETag`:

```bash
curl -X POST "http://localhost:3000/videos/ABC123XYZ0/upload/confirm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "uploadId": "upload-id-s3-...",
    "parts": [
      { "ETag": "\"79f3fdc1072a50919ec69c5b7b6667d0\"", "PartNumber": 1 }
    ]
  }'
```

**Resposta:**
```json
{
  "id": "uuid-do-video",
  "videoId": "ABC123XYZ0",
  "status": "UPLOADED"
}
```

---

### 4.5. Passo 4: Acompanhar o Processamento no Terminal do Worker
No terminal onde o `npm run start:worker` está rodando, você observará os logs em tempo real:

```text
[Nest] LOG [VideoProcessingProcessor] Processing video job for videoId: uuid-do-video
[Nest] LOG [VideoProcessingProcessor] Video uuid-do-video processed successfully (duration: 5s)
```

O worker realiza automaticamente:
1. Atualização para `PROCESSING`.
2. Download temporário do arquivo.
3. Extração da duração (`duration: 5s`) via `ffprobe`.
4. Captura do frame de thumbnail no timestamp `0.5s` via `ffmpeg` (`min(10s, duration * 10%)`).
5. Envio da thumbnail para `thumbnails/ABC123XYZ0.jpg` no MinIO.
6. Atualização para status `READY`.

---

### 4.6. Passo 5: Consultar Informações do Vídeo Processado (`GET /videos/:videoId`)

```bash
curl -X GET "http://localhost:3000/videos/ABC123XYZ0"
```

**Resposta Completa:**
```json
{
  "id": "uuid-do-video",
  "videoId": "ABC123XYZ0",
  "title": "Meu Vídeo de Teste",
  "status": "READY",
  "duration": 5,
  "s3Key": "raw-videos/ABC123XYZ0/sample_test.mp4",
  "thumbnailKey": "thumbnails/ABC123XYZ0.jpg",
  "streamUrl": "http://localhost:9000/streamtube-videos/raw-videos/ABC123XYZ0/sample_test.mp4?...",
  "downloadUrl": "http://localhost:9000/streamtube-videos/raw-videos/ABC123XYZ0/sample_test.mp4?response-content-disposition=attachment...",
  "thumbnailUrl": "http://localhost:9000/streamtube-videos/thumbnails/ABC123XYZ0.jpg?..."
}
```

---

### 4.7. Passo 6: Reproduzir em Streaming / Download
- **Streaming (Redirecionamento 302 direto pro S3):**
  ```bash
  curl -i "http://localhost:3000/videos/ABC123XYZ0/stream"
  ```
- **Download do Arquivo (Com Content-Disposition attachment):**
  ```bash
  curl -i "http://localhost:3000/videos/ABC123XYZ0/download"
  ```
- **Visualizar o arquivo enviado no MinIO**:
  Acesse [http://localhost:9001](http://localhost:9001) > Bucket `streamtube-videos` e navegue pelas pastas `raw-videos/` e `thumbnails/`.
