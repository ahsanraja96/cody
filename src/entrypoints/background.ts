import { defineBackground } from 'wxt/utils/define-background';
import { setupBackground } from '@/lib/background';

export default defineBackground({
  type: 'module',
  main() {
    setupBackground();
  },
});
