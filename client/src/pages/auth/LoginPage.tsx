import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router-dom'
import { HardDrive, KeyRound } from 'lucide-react'
import { startAuthentication } from '@simplewebauthn/browser'
import { authApi } from '../../services/auth.service'
import { useAuthStore } from '../../store/auth.store'
import { toast } from '../../store/toast.store'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { queryClient } from '../../lib/queryClient'

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Password is required'),
})
type FormData = z.infer<typeof schema>

export default function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormData>({
    resolver: zodResolver(schema),
  })

  const onSubmit = async (data: FormData) => {
    try {
      const res = await authApi.login(data)
      const { user, accessToken } = res.data.data
      queryClient.clear()
      setAuth(user, accessToken)
      toast.success(`Welcome back, ${user.name}!`)
      navigate('/dashboard')
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Login failed'
      toast.error(msg)
    }
  }

  const [passkeyBusy, setPasskeyBusy] = useState(false)

  const loginWithPasskey = async () => {
    setPasskeyBusy(true)
    try {
      const opts = await authApi.passkeyLoginOptions()
      const assertion = await startAuthentication({ optionsJSON: opts.data.data.options })
      const res = await authApi.passkeyLoginVerify(assertion)
      const { user, accessToken } = res.data.data
      queryClient.clear()
      setAuth(user, accessToken)
      toast.success(`Welcome back, ${user.name}!`)
      navigate('/dashboard')
    } catch (err: unknown) {
      const apiMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      if (apiMsg) toast.error(apiMsg)
      else if ((err as Error)?.name === 'NotAllowedError') { /* user cancelled the browser prompt */ }
      else toast.error('Passkey login failed')
    } finally {
      setPasskeyBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center bg-blue-600 rounded-2xl p-3 mb-4">
            <HardDrive className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">DbBackup</h1>
          <p className="text-gray-500 mt-1">Sign in to your account</p>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Input
              label="Email"
              type="email"
              placeholder="you@example.com"
              error={errors.email?.message}
              {...register('email')}
            />
            <Input
              label="Password"
              type="password"
              placeholder="••••••••"
              error={errors.password?.message}
              {...register('password')}
            />
            <Button type="submit" className="w-full" loading={isSubmitting}>
              Sign in
            </Button>
          </form>

          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400 uppercase">or</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          <Button variant="outline" className="w-full" onClick={loginWithPasskey} disabled={passkeyBusy}>
            <KeyRound className="h-4 w-4" />{passkeyBusy ? 'Waiting for passkey…' : 'Sign in with passkey'}
          </Button>

          <p className="text-center text-xs text-gray-400 mt-4">
            Use at your own risk — no warranty.{' '}
            <Link to="/terms" className="underline hover:text-gray-600">Terms of Service</Link>
          </p>

          <p className="text-center text-sm text-gray-500 mt-4">
            Don't have an account?{' '}
            <Link to="/register" className="text-blue-600 font-medium hover:underline">
              Create one
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
