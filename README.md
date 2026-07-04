# HTI

브라우저에서 허밍을 녹음하고 MIDI로 변환해 피아노롤에서 확인·재생하는 웹 앱입니다. 오디오는 서버로 전송하지 않고 기기 안에서 처리합니다.

## 실행

```bash
npm install
npm run dev
```

브라우저에서 표시된 로컬 주소를 열고 마이크 권한을 허용합니다. 30초 이내로 허밍을 녹음한 뒤 `MIDI로 변환`을 누르면 됩니다.

## 주요 구성

- Spotify Basic Pitch: 브라우저 내 음표 추출
- tonejs-instruments + Tone.js: 샘플 기반 피아노 재생
- @tonejs/midi: `.mid` 파일 생성
- React + Vite: UI와 빌드

## 확인 명령

```bash
npm run lint
npm run build
```
