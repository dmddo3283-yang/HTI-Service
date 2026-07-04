import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  cacheDir: 'node_modules/.vite-hum-note',
  optimizeDeps: {
    // 무거운 라이브러리(tone: 185개 모듈, @tensorflow/tfjs: 860+개 모듈)를
    // 제외(exclude)하면 dev 서버가 이들을 개별 ESM 파일로 하나씩 전송하게 되어
    // 변환/재생 버튼을 누르는 순간 수백~수천 건의 요청 폭주가 발생하고 탭이 멈춘다.
    // esbuild로 미리 번들링(pre-bundle)하도록 include에 명시해 요청을 1건으로 합친다.
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@spotify/basic-pitch',
      '@tensorflow/tfjs',
      'tone',
      '@tonejs/midi',
    ],
  },
})
